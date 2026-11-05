# MuseWeaver verification requirements

## Scope

A local mathematical verifier and a browser verification studio. Bundled traces are illustrative. Kiro assets are configuration, not authenticated usage evidence.

## EARS requirements

- WHEN a supported structured proposal is received, THE SYSTEM SHALL search for a Z3 counterexample to the specified integer transition.
- WHEN a proposal is malformed, unsupported or inconclusive, THE SYSTEM SHALL deny mathematical approval.
- WHEN custom source is edited, THE SYSTEM SHALL execute it only in the opaque-frame worker and SHALL NOT reuse bundled-code certificates.
- WHEN a worker exceeds the host-owned deadline, THE SYSTEM SHALL remove its frame and report a timeout.
- WHEN live inference is explicitly selected, THE SYSTEM SHALL require an exact allowed endpoint and session-only credentials.
- WHEN seeded tests are requested, THE SYSTEM SHALL preserve seed zero and reject out-of-range controls.

## Acceptance evidence

Run the actual Node and Python regression suites. Formal source model scope, integer counterexamples and shader-free browser isolation must be inspectable. No arbitrary-program proof, model inference or real Kiro session is implied by this file.
