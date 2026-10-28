import { Type } from '@earendil-works/pi-ai';

const material = Type.Union(
  ['grass', 'dirt', 'stone', 'wood'].map((v) => Type.Literal(v)),
);
const coordinates = {
  x: Type.Integer(),
  y: Type.Integer({ minimum: 1 }),
  z: Type.Integer(),
};
const block = Type.Object({
  ...coordinates,
  material: Type.Union([material, Type.Null()]),
});

export const worldToolSchemas = {
  observe: Type.Object({}),
  chat: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 240 }),
    relatedToTask: Type.Optional(Type.Boolean()),
  }),
  goto: Type.Object({
    x: Type.Number({ minimum: -11.7, maximum: 11.7 }),
    y: Type.Number({ minimum: 0.5, maximum: 15.6 }),
    z: Type.Number({ minimum: -11.7, maximum: 11.7 }),
  }),
  follow: Type.Object({
    playerId: Type.String({ minLength: 1, maxLength: 128 }),
    distance: Type.Number({ minimum: 0.8, maximum: 4 }),
  }),
  edit: block,
  build: Type.Object({
    blocks: Type.Array(block, { minItems: 1, maxItems: 64 }),
  }),
  house: Type.Object({
    ...coordinates,
    width: Type.Integer({ minimum: 3, maximum: 7 }),
    depth: Type.Integer({ minimum: 3, maximum: 7 }),
    height: Type.Integer({ minimum: 4, maximum: 6 }),
    material,
    door: Type.Union(
      ['north', 'south', 'east', 'west'].map((v) => Type.Literal(v)),
    ),
  }),
};

export const taskToolSchemas = {
  complete_task: Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 500 }),
  }),
  report_blocked: Type.Object({
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }),
  request_input: Type.Object({
    question: Type.String({ minLength: 1, maxLength: 240 }),
  }),
  wait_for: Type.Object({
    condition: Type.Union([Type.Literal('world'), Type.Literal('players')]),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }),
};

export const toolSchemas = {
  ...worldToolSchemas,
  ...taskToolSchemas,
};

const reply = Type.String({ minLength: 1, maxLength: 240 });
const goal = Type.String({ minLength: 1, maxLength: 2000 });
const command = { reply: Type.Optional(reply) };

export const conversationToolSchemas = {
  reply: Type.Object({
    text: reply,
    relatedToTask: Type.Optional(Type.Boolean()),
  }),
  start_task: Type.Object({ goal, ...command }),
  revise_task: Type.Object({ goal, ...command }),
  pause_task: Type.Object(command),
  resume_task: Type.Object(command),
  cancel_task: Type.Object(command),
};
