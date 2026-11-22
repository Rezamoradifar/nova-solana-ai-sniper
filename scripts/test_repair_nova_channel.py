"""Offline tests for non-financial Telegram recovery policy; no Docker/network."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "nova_channel_repair", Path(__file__).with_name("repair-nova-channel.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MarketingRecoveryTests(unittest.TestCase):
    def test_preserves_unrelated_settings_and_enables_only_daily_flags(self):
        original = ("# channel configuration\n"
                    "OTHER_SECRET=value\n"
                    "TELEGRAM_TRADES_ONLY=true\n"
                    "MARKETING_DAILY_POSTS_ENABLED=false\n"
                    "API_SAFETY_STOP=true\n")
        result = module.with_daily_posts(original)
        self.assertIn("TELEGRAM_TRADES_ONLY=false\n", result)
        self.assertIn("MARKETING_DAILY_POSTS_ENABLED=true\n", result)
        self.assertIn("API_SAFETY_STOP=true\n", result)
        self.assertIn("OTHER_SECRET=value\n", result)
        self.assertEqual(module.with_daily_posts(result), result)

    def test_adds_missing_flags_without_changing_other_values(self):
        result = module.with_daily_posts("A=B")
        self.assertEqual(result, "A=B\nTELEGRAM_TRADES_ONLY=false\nMARKETING_DAILY_POSTS_ENABLED=true\n")

    def test_rejects_duplicate_known_credentials(self):
        with self.assertRaises(module.Blocked):
            module.env_vars("TELEGRAM_BOT_TOKEN=a\nTELEGRAM_BOT_TOKEN=b\n")

    def test_rejects_duplicate_flags(self):
        with self.assertRaises(module.Blocked):
            module.with_daily_posts("TELEGRAM_TRADES_ONLY=true\nTELEGRAM_TRADES_ONLY=false\n")

    def test_preserves_quotes_for_unrelated_env_values(self):
        original = 'DATABASE_URL="postgresql://secret@host/db"\nTELEGRAM_TRADES_ONLY=true\n'
        changed = module.with_daily_posts(original)
        self.assertIn('DATABASE_URL="postgresql://secret@host/db"\n', changed)

    def test_never_executes_shell_expansion_in_credential_value(self):
        with self.assertRaises(module.Blocked):
            module.env_vars("TELEGRAM_BOT_TOKEN=$(echo secret)\n")


if __name__ == "__main__":
    unittest.main()
