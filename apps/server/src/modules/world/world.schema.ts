import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
export class Avatar extends Schema {
  id = '';
  name = '';
  kind = 'human';
  x = 0;
  y = 2.55;
  z = 0;
  yaw = 0;
  connected = true;
  voiceSending = false;
  voiceListening = false;
  voiceReplies = false;
}
defineTypes(Avatar, {
  id: 'string',
  name: 'string',
  kind: 'string',
  x: 'number',
  y: 'number',
  z: 'number',
  yaw: 'number',
  connected: 'boolean',
  voiceSending: 'boolean',
  voiceListening: 'boolean',
  voiceReplies: 'boolean',
});
export class WorldState extends Schema {
  players = new MapSchema<Avatar>();
  revision = 0;
}
defineTypes(WorldState, { players: { map: Avatar }, revision: 'number' });
