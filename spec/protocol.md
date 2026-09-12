# Observable protocol

This is the interoperability contract the tunnel satisfies. Everything here is inferred from the working provider, not from a capture of the production relay, so every value is marked by confidence and must be confirmed against a real relay before it is trusted in production.

## Outer protocol

One UDP flow between the local socket and one known relay address. The stack, in order:

```text
UDP datagrams
    ICE / STUN       connectivity checks, consent freshness
    DTLS 1.2         encryption
    SCTP             one association, port 5000
    stream 0         unordered, maxRetransmits 0
    opaque bytes     the caller payload
```

## Parameters

| Parameter          | Value                      | Confidence                    |
| ------------------ | -------------------------- | ----------------------------- |
| DataChannel id     | 0                          | pre-negotiated, from provider |
| ordered            | false                      | pre-negotiated, from provider |
| maxRetransmits     | 0                          | pre-negotiated, from provider |
| SCTP port          | 5000                       | provider SDP `a=sctp-port`    |
| DTLS role          | peer passive, local active | provider `a=setup:passive`    |
| Fingerprint        | SHA-256, colon hex         | remote certificate            |
| `m=` port          | 9                          | synthesized, standard discard |
| `c=` address       | 0.0.0.0                    | synthesized                   |
| candidate priority | 2130706431                 | host, standard                |
| max-message-size | 262144 | negotiated ceiling |

Both DTLS roles interoperate: the tunnel as server pairs with a peer that answers `active`, and the tunnel as offerer uses the peer as server.

## What the tunnel synthesizes

For the relay path the peer is passive and its parameters are known up front, so the tunnel does not negotiate SDP. On construction it creates the peer connection, creates the negotiated data channel with the parameters above, adds the local host candidate, creates an offer and sets a synthesized remote answer carrying the relay address, ICE credentials, `a=setup:passive` and the remote fingerprint.

The offer is exposed as `Tunnel::offer_sdp`. For explicit offer/answer with a real peer, `Tunnel::offerer` plus `apply_remote_answer_sdp` and `Tunnel::answerer` are available.

## Opening

The tunnel emits `Opened` when the data channel becomes usable, which for a negotiated channel happens at SCTP association establishment. It does not wait for the peer-connection layer's `OnOpen` event.

## Inner protocol

The bytes on the channel are opaque and carry the caller's own relay protocol, including the TURN Allocate and its response. The tunnel never parses them. Its whole application surface is:

```text
send_message(bytes)
receive_message(bytes)
```
