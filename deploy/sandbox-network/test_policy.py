import ipaddress
import os
from pathlib import Path
import subprocess
import unittest

import kubernetes_validate
import yaml

ROOT = Path(__file__).resolve().parents[2]


class SandboxNetworkPolicyTest(unittest.TestCase):
    def test_rendered_environments(self):
        for environment, suffix in [("prod", ""), ("dev", "-dev")]:
            with self.subTest(environment=environment):
                rendered = subprocess.check_output(
                    [os.environ.get("KUBECTL", "kubectl"), "kustomize",
                     str(ROOT / "deploy/sandbox-network" / environment)],
                    text=True,
                )
                documents = list(yaml.safe_load_all(rendered))
                self.assertEqual(len(documents), 1)
                policy = documents[0]
                kubernetes_validate.validate(policy, "1.30.0", strict=True)
                self.assertEqual(policy["metadata"]["namespace"], f"cohub-sessions{suffix}")
                spec = policy["spec"]
                self.assertEqual(spec["podSelector"], {"matchLabels": {"app": "agent-sandbox"}})
                self.assertEqual(set(spec["policyTypes"]), {"Ingress", "Egress"})
                self.assertEqual(len(spec["ingress"]), 2)
                self.assertEqual(len(spec["egress"]), 3)

                control, public = spec["ingress"]
                self.assertEqual(control["from"], [{
                    "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"cohub{suffix}"}},
                    "podSelector": {"matchExpressions": [{
                        "key": "app.kubernetes.io/name", "operator": "In",
                        "values": [f"{name}{suffix}" for name in [
                            "cohub-api", "cohub-worker", "cohub-user-worker",
                            "cohub-system-worker", "cohub-gateway",
                        ]],
                    }]},
                }])
                self.assertEqual(control["ports"], [{"protocol": "TCP", "port": port} for port in [8788, 3000, 5173]])
                self.assertEqual(public["from"], [{
                    "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                    "podSelector": {"matchLabels": {"app.kubernetes.io/name": "traefik"}},
                }])
                self.assertEqual(public["ports"], [{"protocol": "TCP", "port": port} for port in [3000, 5173]])

                dns, api, internet = spec["egress"]
                self.assertEqual(dns, {
                    "to": [{
                        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                        "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}},
                    }],
                    "ports": [{"protocol": protocol, "port": 53} for protocol in ["UDP", "TCP"]],
                })
                self.assertEqual(api, {
                    "to": [{
                        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"cohub{suffix}"}},
                        "podSelector": {"matchLabels": {"app.kubernetes.io/name": f"cohub-api{suffix}"}},
                    }],
                    "ports": [{"protocol": "TCP", "port": 8787}],
                })
                self.assertEqual(set(internet), {"to"})
                self.assertEqual(len(internet["to"]), 1)
                block = internet["to"][0]["ipBlock"]
                self.assertEqual(block["cidr"], "0.0.0.0/0")
                excluded = [ipaddress.ip_network(cidr) for cidr in block["except"]]
                for address in [
                    "100.100.100.200", "169.254.169.254", "169.254.170.2",
                    "168.63.129.16", "10.96.0.1", "10.162.73.230",
                    "172.16.0.1", "172.31.255.255", "192.168.1.1",
                    "127.0.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1",
                ]:
                    self.assertTrue(any(ipaddress.ip_address(address) in network for network in excluded), address)
                for address in ["1.1.1.1", "8.8.8.8", "93.184.216.34"]:
                    self.assertFalse(any(ipaddress.ip_address(address) in network for network in excluded), address)
                # 仅允许 IPv4 公网；IPv6 元数据和地址转换路径保持默认拒绝。
                self.assertTrue(all(network.version == 4 for network in excluded))

    def test_deployment_paths(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/api-docker-build-push.yml").read_text())
        for environment in ["dev", "prod"]:
            steps = workflow["jobs"][f"deploy-{environment}"]["steps"]
            deploy = next(step["run"] for step in steps if step["name"] == f"Deploy to {environment.title()}")
            self.assertLess(deploy.index(f"kubectl apply -k deploy/sandbox-network/{environment}"), deploy.index("kubectl set image"))
            script = (ROOT / f"deploy/api/{environment}/deploy.sh").read_text()
            self.assertLess(script.index(f'sandbox-network/{environment}"'), script.index("kubectl apply -f rendered/deployment.yaml"))


if __name__ == "__main__":
    unittest.main()
