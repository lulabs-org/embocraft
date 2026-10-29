"""Run with python3 docker/test-speech-entrypoint.py."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    'speech_entrypoint', Path(__file__).with_name('speech-entrypoint.py'))
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)


class StartupTests(unittest.TestCase):
    def registry(self, installed):
        registry = Mock()
        registry.list_local_models.side_effect = lambda: [
            SimpleNamespace(id=model) for model in installed]
        registry.download_model_files.side_effect = installed.add
        return registry

    def test_cached_models_start_offline_without_downloads(self):
        registry = self.registry(set(entrypoint.PIPER_MODELS))
        entrypoint.prepare_models(registry)
        registry.download_model_files.assert_not_called()

    def test_downloads_only_missing_models_and_reuses_them_on_restart(self):
        installed = {entrypoint.PIPER_MODELS[0]}
        registry = self.registry(installed)
        entrypoint.prepare_models(registry)
        self.assertEqual(installed, set(entrypoint.PIPER_MODELS))
        self.assertEqual(registry.download_model_files.call_count, 2)
        registry.download_model_files.reset_mock()
        entrypoint.prepare_models(registry)
        registry.download_model_files.assert_not_called()

    def test_retries_transient_failure(self):
        installed = set(entrypoint.PIPER_MODELS[1:])
        registry = self.registry(installed)
        attempts = 0

        def download(model):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError('Network unavailable')
            installed.add(model)

        registry.download_model_files.side_effect = download
        sleep = Mock()
        entrypoint.prepare_models(registry, sleep)
        self.assertEqual(attempts, 2)
        sleep.assert_called_once_with(5)

    def test_incomplete_download_prevents_ready_but_other_models_are_prepared(self):
        installed = set()
        registry = self.registry(installed)
        registry.download_model_files.side_effect = lambda model: (
            installed.add(model) if model != entrypoint.PIPER_MODELS[0] else None)
        with self.assertRaisesRegex(RuntimeError, 'Unable to prepare models'):
            entrypoint.prepare_models(registry, Mock())
        self.assertEqual(installed, set(entrypoint.PIPER_MODELS[1:]))
        self.assertEqual(registry.download_model_files.call_count, 5)


if __name__ == '__main__':
    unittest.main()
