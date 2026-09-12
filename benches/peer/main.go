// Command bench-peer is a neutral WebRTC echo peer for the benchmark.
//
// It sits at the far end of a real UDP path and speaks the same wire to every
// device under test: one negotiated, unordered, zero-retransmit data channel on
// stream 0, echo on receive. It always answers with static ICE credentials and
// the passive DTLS role, so all three DUTs are offerers and every one of them
// faces identical peer behavior. Pion is a separate implementation from the
// webRTC stacks under test, so a bug shared between a DUT and the reference
// peer cannot hide here.
//
// Protocol, line oriented over stdin/stdout:
//
//	... stdin: OFFER <base64 sdp>
//	READY <ip> <port> <ufrag> <pwd>
//	ANSWER <base64 sdp>
//	OPEN
//	CLOSED <reason>
//
// Diagnostics go to stderr, so stdout stays clean for the protocol.
package main

import (
	"bufio"
	"encoding/base64"
	"flag"
	"fmt"
	"math/rand"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

const (
	defaultUfrag = "benchufrag"
	defaultPwd   = "benchpwdbenchpwdbenchpwd"
)

var (
	stdout     = bufio.NewWriter(os.Stdout)
	stdoutLock sync.Mutex
)

func emit(format string, args ...any) {
	stdoutLock.Lock()
	defer stdoutLock.Unlock()
	fmt.Fprintf(stdout, format+"\n", args...)
	_ = stdout.Flush()
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "bench-peer: "+format+"\n", args...)
	os.Exit(1)
}

// localIPv4 returns the first global unicast IPv4 address, matching how the
// TypeScript backends choose their interface. An explicit --host overrides it,
// so the runner can pin every process to the same interface.
func localIPv4() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip != nil && !ip.IsLoopback() && ip.IsGlobalUnicast() {
				return ip.String(), nil
			}
		}
	}
	return "", fmt.Errorf("no global IPv4 address found")
}

// firstHostCandidate extracts the first host UDP candidate from an SDP body.
func firstHostCandidate(sdp string) (string, int, bool) {
	for _, raw := range strings.Split(sdp, "\n") {
		line := strings.TrimSpace(raw)
		rest, ok := strings.CutPrefix(line, "a=candidate:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 8 {
			continue
		}
		if fields[1] != "1" || !strings.EqualFold(fields[2], "udp") || fields[7] != "host" {
			continue
		}
		port, err := strconv.Atoi(fields[5])
		if err != nil {
			continue
		}
		return fields[4], port, true
	}
	return "", 0, false
}

func waitGathering(pc *webrtc.PeerConnection, timeout time.Duration) {
	done := webrtc.GatheringCompletePromise(pc)
	select {
	case <-done:
	case <-time.After(timeout):
		emit("ERROR gathering timed out")
	}
}

// impairment wraps the UDP socket the mux reads and writes, applying loss,
// jitter and reordering to outbound datagrams. Outbound impairment is enough to
// exercise the far end: a dropped or delayed STUN response, DTLS flight or SCTP
// chunk looks exactly like loss on the return path, and forces the device under
// test to retransmit or wait on its own timers.
type impairment struct {
	conn    net.PacketConn
	loss    float64
	jitter  time.Duration
	reorder float64
	rng     *rand.Rand
	mu      sync.Mutex
}

func newImpairment(conn net.PacketConn, loss float64, jitter time.Duration, reorder float64) *impairment {
	return &impairment{
		conn:    conn,
		loss:    loss,
		jitter:  jitter,
		reorder: reorder,
		rng:     rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (i *impairment) ReadFrom(p []byte) (int, net.Addr, error) { return i.conn.ReadFrom(p) }

func (i *impairment) WriteTo(p []byte, addr net.Addr) (int, error) {
	i.mu.Lock()
	drop := i.rng.Float64() < i.loss
	delay := time.Duration(0)
	if i.jitter > 0 {
		delay = time.Duration(i.rng.Float64() * float64(2*i.jitter))
	}
	if i.reorder > 0 && i.rng.Float64() < i.reorder {
		delay += i.jitter
	}
	i.mu.Unlock()

	if drop {
		return len(p), nil
	}
	if delay <= 0 {
		return i.conn.WriteTo(p, addr)
	}
	buffer := append([]byte(nil), p...)
	time.AfterFunc(delay, func() { _, _ = i.conn.WriteTo(buffer, addr) })
	return len(p), nil
}

func (i *impairment) Close() error                       { return i.conn.Close() }
func (i *impairment) LocalAddr() net.Addr                { return i.conn.LocalAddr() }
func (i *impairment) SetDeadline(t time.Time) error      { return i.conn.SetDeadline(t) }
func (i *impairment) SetReadDeadline(t time.Time) error  { return i.conn.SetReadDeadline(t) }
func (i *impairment) SetWriteDeadline(t time.Time) error { return i.conn.SetWriteDeadline(t) }

func main() {
	host := flag.String("host", "", "interface address to bind and advertise (default: first global IPv4)")
	ufrag := flag.String("ufrag", defaultUfrag, "static ICE username fragment")
	pwd := flag.String("pwd", defaultPwd, "static ICE password")
	lifetime := flag.Duration("lifetime", 120*time.Second, "maximum process lifetime")
	logMessages := flag.Bool("log-messages", false, "print one line per echoed message")
	logLevel := flag.String("log-level", "error", "pion log level: error, warn, info, debug, trace")
	loss := flag.Float64("loss", 0, "fraction of outbound datagrams to drop, 0..1")
	jitterMs := flag.Float64("jitter-ms", 0, "maximum outbound delay in milliseconds")
	reorder := flag.Float64("reorder", 0, "fraction of outbound datagrams to delay by the jitter window")
	mode := flag.String("mode", "echo", "echo, sink, or source: sink consumes only, source emits at --rate")
	rate := flag.Int("rate", 0, "messages per second for --mode source, 0 for unthrottled")
	payloadBytes := flag.Int("payload", 1200, "payload bytes for --mode source")
	flag.Parse()

	bindHost := *host
	if bindHost == "" {
		var err error
		if bindHost, err = localIPv4(); err != nil {
			fail("%v", err)
		}
	}

	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(bindHost), Port: 0})
	if err != nil {
		fail("bind %s: %v", bindHost, err)
	}
	var impairedConn net.PacketConn = conn
	if *loss > 0 || *jitterMs > 0 || *reorder > 0 {
		impairedConn = newImpairment(conn, *loss, time.Duration(*jitterMs)*time.Millisecond, *reorder)
	}
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: impairedConn})
	defer mux.Close()

	// READY is emitted before any signaling. A relay-path DUT must configure its
	// synthesized answer from these static credentials and this port before it
	// can produce an offer, so the peer cannot wait for that offer to reveal them.
	emit("READY %s %d %s %s", bindHost, conn.LocalAddr().(*net.UDPAddr).Port, *ufrag, *pwd)

	var settingEngine webrtc.SettingEngine
	factory := logging.NewDefaultLoggerFactory()
	switch *logLevel {
	case "trace":
		factory.DefaultLogLevel = logging.LogLevelTrace
	case "debug":
		factory.DefaultLogLevel = logging.LogLevelDebug
	case "info":
		factory.DefaultLogLevel = logging.LogLevelInfo
	case "warn":
		factory.DefaultLogLevel = logging.LogLevelWarn
	}
	settingEngine.LoggerFactory = factory
	settingEngine.SetICECredentials(*ufrag, *pwd)
	settingEngine.SetICEUDPMux(mux)
	settingEngine.SetSCTPMaxReceiveBufferSize(16 * 1024 * 1024)
	if err := settingEngine.SetAnsweringDTLSRole(webrtc.DTLSRoleServer); err != nil {
		fail("set answering DTLS role: %v", err)
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		fail("new peer connection: %v", err)
	}
	defer pc.Close()

	var echoes atomic.Uint64
	var channel *webrtc.DataChannel
	closed := make(chan struct{})
	var once atomic.Bool
	markClosed := func(reason string) {
		if once.CompareAndSwap(false, true) {
			emit("CLOSED %s", reason)
			close(closed)
		}
	}

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		fmt.Fprintf(os.Stderr, "bench-peer: ice %s\n", state)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		fmt.Fprintf(os.Stderr, "bench-peer: connection %s\n", state)
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			markClosed(state.String())
		}
	})

	// Read the offer before configuring the negotiated channel, so the channel
	// exists when the answer is built.
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()

	var offerLine string
	for line := range lines {
		if strings.HasPrefix(line, "OFFER ") {
			offerLine = strings.TrimPrefix(line, "OFFER ")
			break
		}
	}
	if offerLine == "" {
		fail("no OFFER line received")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(offerLine))
	if err != nil {
		fail("decode offer: %v", err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  string(raw),
	}); err != nil {
		fail("set remote description: %v", err)
	}

	ordered := false
	maxRetransmits := uint16(0)
	streamID := uint16(0)
	negotiated := true
	channel, err = pc.CreateDataChannel("relay", &webrtc.DataChannelInit{
		Ordered:        &ordered,
		MaxRetransmits: &maxRetransmits,
		ID:             &streamID,
		Negotiated:     &negotiated,
	})
	if err != nil {
		fail("create data channel: %v", err)
	}
	channel.OnMessage(func(msg webrtc.DataChannelMessage) {
		if *mode == "sink" {
			echoes.Add(1)
			return
		}
		if err := channel.Send(msg.Data); err != nil {
			fmt.Fprintf(os.Stderr, "bench-peer: echo send: %v\n", err)
			return
		}
		n := echoes.Add(1)
		if *logMessages {
			fmt.Fprintf(os.Stderr, "bench-peer: echo %d\n", n)
		}
	})
	channel.OnOpen(func() {
		emit("OPEN")
		if *mode != "source" {
			return
		}
		// A generator DUT-side RX test: emit a fixed payload at --rate, or as
		// fast as the channel accepts when rate is zero.
		go func() {
			payload := make([]byte, *payloadBytes)
			for i := range payload {
				payload[i] = 7
			}
			var interval time.Duration
			var ticker *time.Ticker
			if *rate > 0 {
				interval = time.Second / time.Duration(*rate)
				ticker = time.NewTicker(interval)
				defer ticker.Stop()
			}
			for {
				select {
				case <-closed:
					return
				default:
				}
				if err := channel.Send(payload); err != nil {
					fmt.Fprintf(os.Stderr, "bench-peer: source send: %v\n", err)
					return
				}
				echoes.Add(1)
				if ticker != nil {
					select {
					case <-closed:
						return
					case <-ticker.C:
					}
				}
			}
		}()
	})
	channel.OnClose(func() {
		markClosed("datachannel")
	})

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		fail("create answer: %v", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		fail("set local description: %v", err)
	}
	waitGathering(pc, 10*time.Second)

	local := pc.LocalDescription()
	if local == nil {
		fail("no local description after gathering")
	}
	emit("ANSWER %s", base64.StdEncoding.EncodeToString([]byte(local.SDP)))

	select {
	case <-closed:
	case <-time.After(*lifetime):
		markClosed("lifetime")
	case <-func() chan struct{} {
		done := make(chan struct{})
		go func() {
			for line := range lines {
				// A sink-mode DUT cannot window against an echo, so it polls the
				// peer's consume count to report delivered TX throughput.
				if strings.HasPrefix(line, "STATS") {
					emit("COUNT %d", echoes.Load())
				}
			}
			close(done)
		}()
		return done
	}():
		markClosed("eof")
	}
}
