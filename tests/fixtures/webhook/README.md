# Webhook fixtures

**These are SYNTHETIC**, hand-built from the documented whatsmeow struct shapes
(`docs/wuzapi-contract.md` §4). They exercise the normalizer's field extraction and
edge cases, but the exact protobuf-go JSON casing of the `Message` sub-object is
**UNVERIFIED** until Phase-0 capture on the VPS (SPEC §14, contract §7).

Phase 0 replaces every `*.synthetic.json` here with a real captured delivery
(same filename minus `.synthetic`), and the normalizer tests re-run against the real
shapes. A wuzapi image bump that changes shapes must fail these tests, not production.
The fixture manifest pins the whatsmeow commit the captures came from.
