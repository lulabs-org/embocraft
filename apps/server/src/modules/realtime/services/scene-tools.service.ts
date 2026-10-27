import { randomUUID } from 'node:crypto';
import { inBounds, type Edit } from '@voxel/shared';

export type SceneAccess = { observe(): unknown; revision(): number };
type Proposal = { id: string; edit: Edit };

const sceneToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'observe_scene',
      description:
        'Read nearby terrain and your position; no people or conversation data.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_block_edit',
      description:
        'Propose one block edit for explicit player approval. Never executes the edit.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          z: { type: 'integer' },
          material: { enum: ['grass', 'dirt', 'stone', 'wood', null] },
        },
        required: ['x', 'y', 'z', 'material'],
        additionalProperties: false,
      },
    },
  },
];

/** Owns consented world tools and one-use proposals; never applies edits. */
export class SceneTools {
  private proposals = new Map<string, { edit: Edit; expires: number }>();
  private closed = false;

  constructor(
    private scene: SceneAccess | undefined,
    private propose: (proposal: Proposal) => void,
  ) {}

  get definitions() {
    return this.scene ? sceneToolDefinitions : [];
  }

  execute(name: unknown, argumentsValue: unknown): unknown {
    if (this.closed) return { error: 'tool-not-allowed' };
    let output: unknown = { error: 'tool-not-allowed' };
    if (this.scene) {
      try {
        if (typeof argumentsValue !== 'string' || argumentsValue.length > 1000)
          throw Error();
        const args = JSON.parse(argumentsValue);
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw Error();
        if (name === 'observe_scene' && Object.keys(args).length === 0)
          output = this.scene.observe();
        if (name === 'propose_block_edit') {
          if (
            !inBounds(args) ||
            !['grass', 'dirt', 'stone', 'wood', null].includes(args.material) ||
            Object.keys(args).some(
              (k) => !['x', 'y', 'z', 'material'].includes(k),
            )
          )
            throw Error();
          if (this.proposals.size >= 8) throw Error();
          const id = randomUUID();
          const edit = {
            x: args.x,
            y: args.y,
            z: args.z,
            material: args.material,
            revision: this.scene.revision(),
          };
          this.proposals.set(id, { edit, expires: Date.now() + 30000 });
          this.propose({ id, edit });
          output = { proposalId: id, status: 'awaiting-player-approval' };
        }
      } catch {
        output = { error: 'invalid-tool-arguments' };
      }
    }
    return output;
  }
  takeProposal(id: unknown): Edit {
    const p = typeof id === 'string' ? this.proposals.get(id) : undefined;
    if (typeof id === 'string') this.proposals.delete(id);
    if (this.closed || !p || p.expires < Date.now())
      throw Error('invalid-or-expired-proposal');
    return p.edit;
  }

  close() {
    this.closed = true;
    this.proposals.clear();
  }
}
