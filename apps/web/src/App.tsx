import { lazy, Suspense, useState } from 'react';
import { GameHUDLayout } from './components/layout/GameHUDLayout';
import { LobbyLayout } from './components/layout/LobbyLayout';
import { ChatPanel } from './features/chat';
import {
  GameFooter,
  GameHeader,
  GameMenu,
  MATERIAL_LABELS,
  useGameShortcuts,
  useHudController,
} from './features/hud';
import { useI18n } from './i18n';

import { SpatialVoicePanel, useAsrSelectionSync } from './features/voice';
import {
  LobbyCard,
  useWorldScene,
  useWorldSession,
  WorldPanel,
} from './features/world';
import { releasePointerLock } from './graphics/controls/pointer-lock';
import { useViewportAdjust } from './hooks/useViewportAdjust';
import type { Connection } from './network/connection';

// Admin UI lives in its own chunk: the game shell only pays for it once the console opens.
const ControlConsole = lazy(async () => {
  const { ControlConsole: Console } = await import('./features/console');
  return { default: Console };
});

function ConsoleLoading() {
  const { t } = useI18n();
  return (
    <>
      <div className="agent-dialog-backdrop" />
      <div
        className="agent-dialog console-loading"
        role="status"
        aria-live="polite"
      >
        {t('common.loading')}
      </div>
    </>
  );
}

export function App({ connection }: { connection: Connection }) {
  useAsrSelectionSync();
  const { t } = useI18n();
  const [consoleEntry, setConsoleEntry] = useState<{
    initialTab?: 'characters';
  } | null>(null);
  // Keep the console mounted after the first open so closing preserves its state.
  const [consoleMounted, setConsoleMounted] = useState(false);

  const { narrow, shortViewport, mainRef } = useViewportAdjust();
  const hud = useHudController();
  const {
    activePanel,
    setActivePanel,
    showCoordinates,
    chatExpanded,
    setChatBusy,
    changeChat,
    togglePanel,
  } = hud;
  const {
    hostRef,
    target,
    material,
    setMaterial,
    editBlock,
    leaveWorldScene,
    speechAnchor,
  } = useWorldScene(connection);
  const session = useWorldSession(connection, leaveWorldScene);
  const { name, setName, joined } = session;
  useGameShortcuts(joined, hud, setMaterial);
  const openConsole = (initialTab?: 'characters') => {
    releasePointerLock();
    setActivePanel(null);
    setConsoleMounted(true);
    setConsoleEntry({ initialTab });
  };
  const joinWorld = () => {
    if (connection.status !== 'connected') setActivePanel(null);
    return session.joinWorld();
  };
  const leaveWorld = () => {
    session.leaveWorld();
    setActivePanel(null);
    hud.setChatExpanded(false);
  };
  return (
    <GameHUDLayout
      joined={joined}
      shortChat={narrow && shortViewport && chatExpanded}
      ref={mainRef}
      data-game-overlay={activePanel || undefined}
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-hud], #world-panel'))
          releasePointerLock();
      }}
    >
      <div className="world" ref={hostRef} />

      <GameHeader
        connectionStatus={connection.status}
        joined={joined}
        isConsoleOpen={consoleEntry !== null}
        isPlayersOpen={activePanel === 'players'}
        onOpenConsole={() => openConsole()}
        onTogglePlayers={() => togglePanel('players')}
        isMenuOpen={activePanel === 'menu'}
        onToggleMenu={() => togglePanel('menu')}
      />

      {joined && <GameMenu hud={hud} leaveWorld={leaveWorld} />}
      <LobbyLayout>
        {!joined && (
          <LobbyCard
            name={name}
            onNameChange={(value) => {
              connection.joinError = '';
              setName(value);
            }}
            error={connection.joinError}
            onJoin={() => void joinWorld()}
            onCreateAgent={() => openConsole('characters')}
          />
        )}
        <WorldPanel
          connection={connection}
          hidden={joined && activePanel !== 'players'}
          onClose={joined ? () => setActivePanel(null) : undefined}
        />
      </LobbyLayout>

      {joined && (
        <>
          <div className="crosshair">+</div>
          {target && (
            <div className="target">
              {t(`hud.materials.${target.material}`) ||
                MATERIAL_LABELS[target.material]}
              {showCoordinates && ` · ${target.x}, ${target.y}, ${target.z}`}
            </div>
          )}
        </>
      )}

      {consoleMounted && (
        <Suspense fallback={<ConsoleLoading />}>
          <ControlConsole
            connection={connection}
            open={consoleEntry !== null}
            initialTab={consoleEntry?.initialTab}
            onClose={() => setConsoleEntry(null)}
          />
        </Suspense>
      )}

      {joined && (
        <div
          className={`game-communication${chatExpanded ? ' has-expanded' : ''}`}
        >
          <SpatialVoicePanel
            speechAnchor={speechAnchor}
            connection={connection}
          />
          <ChatPanel
            connection={connection}
            expanded={chatExpanded}
            onExpandedChange={changeChat}
            onBusyChange={setChatBusy}
          />
        </div>
      )}

      {joined && (
        <GameFooter
          material={material}
          isConnected={connection.status === 'connected'}
          onSelectMaterial={setMaterial}
          onEditBlock={editBlock}
        />
      )}
    </GameHUDLayout>
  );
}
