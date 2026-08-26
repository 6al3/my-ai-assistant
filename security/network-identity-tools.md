# Network Identity Lab Tooling

Use these components only inside an isolated lab namespace/container:

- macchanger — MAC identity test fixture.
- iproute2 — interfaces, addresses, routes and network namespaces.
- arping — ARP visibility/telemetry tests.
- tcpdump — packet evidence capture in the lab.
- NetworkManager/nmcli — interface configuration telemetry where applicable.
- DNS utilities — resolver and DNS-path telemetry.

Detection path:

`fixture -> Falco/OpenTelemetry -> Loki/OpenSearch -> Prometheus/Grafana -> evaluator`

Every run records case_id, fixture, namespace, before/after state hashes, detector, verdict and timestamp. Host network identity is not modified by the fixtures.
