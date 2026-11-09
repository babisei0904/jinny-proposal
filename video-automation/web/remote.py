"""밖에서 쓰기: Tailscale로 연결된 내 기기(폰·다른 컴퓨터)에서만 접속을 허용한다.

- 설정에서 켜면 서버가 다음에 켜질 때 이 맥의 모든 네트워크에서 기다리되,
  이 맥 자신(127.0.0.1)과 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)에서 온 요청만 받는다.
  같은 카페 와이파이 등 다른 곳에서 온 요청은 막는다.
- Tailscale은 내 계정에 로그인한 기기끼리만 연결되므로 따로 비밀번호를 두지 않는다.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys

TAILNET = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]
CLI_PATHS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale",
             "/opt/homebrew/bin/tailscale"]


def is_local(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "testclient")


def is_tailnet(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in net for net in TAILNET)


def allowed(host: str, enabled: bool) -> bool:
    return is_local(host) or (enabled and is_tailnet(host))


def _cli() -> str | None:
    for c in CLI_PATHS:
        p = shutil.which(c) if "/" not in c else (c if os.path.exists(c) else None)
        if p:
            return p
    return None


def _ifconfig_ips() -> list[str]:
    """Tailscale 명령을 못 찾을 때: 이 맥의 네트워크 주소 중 Tailscale 주소를 찾는다."""
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
    except Exception:  # noqa: BLE001
        return []
    return [ip for ip in re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", out) if is_tailnet(ip)]


def tailscale_status() -> dict:
    """Tailscale 설치·로그인 상태와 이 맥의 Tailscale 주소."""
    info = {"installed": False, "running": False, "ips": [], "dns": "", "name": ""}
    cli = _cli()
    if cli:
        info["installed"] = True
        try:
            r = subprocess.run([cli, "status", "--json"], capture_output=True, text=True, timeout=5)
            st = json.loads(r.stdout or "{}")
            me = st.get("Self") or {}
            info["running"] = st.get("BackendState") == "Running"
            info["ips"] = [ip for ip in me.get("TailscaleIPs") or [] if ":" not in ip]
            info["dns"] = (me.get("DNSName") or "").rstrip(".")
            info["name"] = me.get("HostName") or ""
        except Exception:  # noqa: BLE001
            pass
    if not info["ips"]:
        info["ips"] = _ifconfig_ips()
        if info["ips"]:
            info["installed"] = info["running"] = True
    if not info["installed"] and sys.platform == "darwin":
        info["installed"] = os.path.exists("/Applications/Tailscale.app")
    return info


def keep_awake(pid: int) -> None:
    """밖에서 쓰는 동안 맥이 저절로 잠들지 않게 (서버가 꺼지면 같이 풀림). 뚜껑을 닫으면 잠들 수 있다."""
    if sys.platform == "darwin" and shutil.which("caffeinate"):
        subprocess.Popen(["caffeinate", "-i", "-w", str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
