#!/usr/bin/env python3
"""Structural tests for Aider + Repomix OpenRouter setup in project root.

Drives the real shipped config artifacts (.aider.conf.yml, .aiderignore, .env
key presence shape, repomix.xml existence) rather than re-implementing setup.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class AiderSetupTests(unittest.TestCase):
    def test_aider_cli_on_path(self) -> None:
        path = shutil.which("aider")
        self.assertIsNotNone(path, "aider must be on PATH")
        proc = subprocess.run(
            ["aider", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = (proc.stdout or "") + (proc.stderr or "")
        self.assertRegex(out, r"aider\s+\d+", f"unexpected version output: {out!r}")

    def test_repomix_cli_on_path(self) -> None:
        path = shutil.which("repomix")
        self.assertIsNotNone(path, "repomix must be on PATH")
        proc = subprocess.run(
            ["repomix", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = (proc.stdout or proc.stderr or "").strip()
        self.assertTrue(len(out) > 0, "repomix --version produced empty output")

    def test_openrouter_api_key_in_env(self) -> None:
        env_path = ROOT / ".env"
        self.assertTrue(env_path.is_file(), ".env must exist")
        text = env_path.read_text(encoding="utf-8", errors="replace")
        match = re.search(r"^OPENROUTER_API_KEY=(.+)$", text, re.M)
        self.assertIsNotNone(match, "OPENROUTER_API_KEY missing from .env")
        value = match.group(1).strip().strip('"').strip("'")
        self.assertTrue(
            value.startswith("sk-or-v1-"),
            "OPENROUTER_API_KEY must be an OpenRouter key",
        )
        self.assertGreaterEqual(len(value), 40, "OPENROUTER_API_KEY looks too short")

    def test_aider_conf_yml_settings(self) -> None:
        conf_path = ROOT / ".aider.conf.yml"
        self.assertTrue(conf_path.is_file(), ".aider.conf.yml must exist")
        text = conf_path.read_text(encoding="utf-8")
        # Aider architect mode: `model` is the planner/reader; `editor-model` is the coder.
        required = {
            "model": "openrouter/moonshotai/kimi-k3",
            "architect": "true",
            "editor-model": "openrouter/minimax/minimax-m3",
            "cache-prompts": "true",
            "cache-keepalive-pings": "6",
        }
        found: dict[str, str] = {}
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if ":" not in stripped:
                continue
            key, val = stripped.split(":", 1)
            found[key.strip()] = val.strip()
        for key, expected in required.items():
            self.assertEqual(
                found.get(key),
                expected,
                f".aider.conf.yml {key}: got {found.get(key)!r}, want {expected!r}",
            )

    def test_aiderignore_patterns(self) -> None:
        ignore_path = ROOT / ".aiderignore"
        self.assertTrue(ignore_path.is_file(), ".aiderignore must exist")
        text = ignore_path.read_text(encoding="utf-8")
        for pattern in (
            "node_modules/",
            "dist/",
            "build/",
            "*.log",
            "*.sqlite",
            ".env",
        ):
            self.assertIn(pattern, text, f".aiderignore missing pattern {pattern!r}")

    def test_repomix_xml_nonempty_with_structure(self) -> None:
        xml_path = ROOT / "repomix.xml"
        self.assertTrue(xml_path.is_file(), "repomix.xml must exist")
        size = xml_path.stat().st_size
        self.assertGreater(size, 0, "repomix.xml must be non-empty")
        # Read only a prefix so the test stays fast on large packs
        head = xml_path.read_bytes()[:8192].decode("utf-8", errors="replace")
        self.assertIn("<", head, "repomix.xml should contain XML markup")
        # Full file must contain at least one packed file entry
        with xml_path.open("r", encoding="utf-8", errors="replace") as fh:
            saw_file = False
            for i, line in enumerate(fh):
                if "<file " in line or "<file>" in line:
                    saw_file = True
                    break
                if i > 50000:
                    break
            self.assertTrue(saw_file, "repomix.xml missing <file entries")


if __name__ == "__main__":
    # Ensure pipx user bin is visible when tests run under a minimal env
    local_bin = Path.home() / ".local" / "bin"
    if local_bin.is_dir():
        os.environ["PATH"] = f"{local_bin}{os.pathsep}{os.environ.get('PATH', '')}"
    unittest.main()
