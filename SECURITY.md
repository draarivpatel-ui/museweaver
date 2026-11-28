# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/museweaver/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static MuseWeaver browser application and its local verification, export and persistence code.

In scope:

- A cross-site scripting or HTML injection path through proposal data, verifier output, captured traces, lab state or report output.
- A browser worker or execution-sandbox boundary flaw that allows untrusted proposal code to access the host application, network or persistent state.
- A verifier, parser or serialization flaw that treats malformed or inconclusive input as a proof.
- A local persistence flaw that misrepresents isolation or sends proposal data off the device.
- A Z3 wrapper, counterexample renderer or export path that turns attacker-controlled text into executable markup or script.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Approximation or modeling limits already documented by the project, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
