import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_platform', Path(__file__).resolve().parents[1] / 'scripts/release_platform.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class SmokeTests(unittest.TestCase):
    def responses(self, cards):
        return [SimpleNamespace(stdout=json.dumps(body) + '\n' + str(code) + '\napplication/json')
                for body, code in [({'error': 'short'}, 400),
                                   ({'intakeStatus': 'available', 'paymentStatus': 'inactive', 'payUrl': None}, 200),
                                   ({'cards': cards}, 200)]]

    def test_upstream_contract_and_user_agent(self):
        with patch.object(release.subprocess, 'run', side_effect=self.responses([{'name': 'card'}])) as run:
            release.smoke('https://example.invalid', upstream=True)
            self.assertEqual(run.call_count, 3)
            for call in run.call_args_list:
                self.assertIn('gg-release-smoke/1.0', call.args[0])

    def test_rejects_wrong_cards_shape(self):
        with patch.object(release.subprocess, 'run', side_effect=self.responses({})):
            with self.assertRaisesRegex(RuntimeError, 'cards array'):
                release.smoke('https://example.invalid', upstream=True)

    def test_rejects_html_even_with_200(self):
        with patch.object(release.subprocess, 'run', return_value=SimpleNamespace(stdout='{}\n400\ntext/html')):
            with self.assertRaisesRegex(RuntimeError, 'expected JSON'):
                release.smoke('https://example.invalid')


if __name__ == '__main__':
    unittest.main()
