import { useEffect, useState } from 'react';
import type { Connection } from '../../network/connection';
const savedName = sessionStorage.getItem('voxel-name');
export function useWorldSession(
  connection: Connection,
  leaveWorldScene: () => void,
) {
  const [, render] = useState(0);
  const [name, setName] = useState(savedName ?? '');
  const [joined, setJoined] = useState(!!savedName);

  useEffect(() => {
    connection.onChange = () => {
      if (connection.joinError) setJoined(false);
      render((n) => n + 1);
    };
    if (savedName) void connection.connect(savedName);
    return () => {
      connection.onChange = () => {};
    };
  }, [connection]);

  const joinWorld = async () => {
    if (connection.status === 'connected') return true;
    const explorerName = name.trim();
    if (!explorerName) return false;
    setName(explorerName);
    setJoined(true);
    sessionStorage.setItem('voxel-name', explorerName);
    await connection.connect(explorerName);
    return connection.status === 'connected';
  };

  const leaveWorld = () => {
    leaveWorldScene();
    connection.leave();
    setJoined(false);
  };

  return { name, setName, joined, joinWorld, leaveWorld };
}
