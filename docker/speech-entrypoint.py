"""Prepare the console's Piper voices in the persistent cache before serving."""
import os
import sys
import time

PIPER_MODELS = (
    'speaches-ai/piper-zh_CN-huayan-medium',
    'speaches-ai/piper-en_US-lessac-medium',
    'rhasspy/piper-voices/zh_CN-chaowen-medium',
)


def prepare_models(registry, sleep=time.sleep):
    failed = []
    for model_id in PIPER_MODELS:
        for attempt in range(1, 4):
            try:
                installed = {model.id for model in registry.list_local_models()}
                if model_id not in installed:
                    print(f'[speech-init] Downloading {model_id} (attempt {attempt}/3)', flush=True)
                    registry.download_model_files(model_id)
                    installed = {model.id for model in registry.list_local_models()}
                    if model_id not in installed:
                        raise RuntimeError('Model files are incomplete after download')
                print(f'[speech-init] Ready: {model_id}', flush=True)
                break
            except Exception as error:
                print(f'[speech-init] Failed: {model_id}: {error}', file=sys.stderr, flush=True)
                if attempt < 3:
                    sleep(5 * attempt)
                else:
                    failed.append(model_id)
    if failed:
        raise RuntimeError('Unable to prepare models: ' + ', '.join(failed))


def main():
    from speaches.executors.piper.utils import model_registry

    prepare_models(model_registry)
    command = sys.argv[1:] or ['uvicorn', '--factory', 'speaches.main:create_app']
    # Replace the initializer so Docker signals reach the speech server directly.
    os.execvp(command[0], command)


if __name__ == '__main__':
    main()
