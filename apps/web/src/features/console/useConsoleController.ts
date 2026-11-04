import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAICharactersController } from './ai-characters';
import { useProvidersController } from './providers/useProvidersController';
import { useConsoleFeedback } from './useConsoleFeedback';
import { useVoiceServices } from './voice/useVoiceServices';
import { useLiveVoiceServices } from './voice/useLiveVoiceServices';
export function useConsoleController(open: boolean, initialTab?: 'characters') {
  const [tab, setTab] = useState<
    | 'characters'
    | 'plans'
    | 'providers'
    | 'voice'
    | 'asr'
    | 'asrInput'
    | 'liveVoice'
  >('characters');
  const body = useRef<HTMLDivElement>(null);
  const feedback = useConsoleFeedback();
  const providers = useProvidersController(open, tab, feedback);
  const characters = useAICharactersController(
    open,
    initialTab,
    providers.providers,
    providers.resetModels,
    feedback,
  );
  const voices = useVoiceServices(open, feedback.setError);
  const liveVoices = useLiveVoiceServices(open, feedback.setError);
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [characters.showAgentForm, tab]);
  return {
    ...feedback,
    ...providers,
    ...characters,
    ...voices,
    ...liveVoices,
    tab,
    setTab,
    body,
    saveProvider: (event: FormEvent) =>
      providers.saveProvider(event, characters.providerSaved),
    removeProvider: () => providers.removeProvider(characters.providerRemoved),
  };
}
export type ConsoleController = ReturnType<typeof useConsoleController>;
