import { useEffect, useState } from 'react';
import type { BailianAsrDraft, SenseVoiceLanguage } from '@voxel/shared';
import type {
  AsrProvider,
  WebAsrDraft,
  WebAsrService,
} from './browser-asr-services';
import { browserLanguages } from './browser-asr-languages';
import type { useAsrServices } from './useAsrServices';

const senseVoiceLanguages: [SenseVoiceLanguage, string][] = [
  ['zh', '中文（默认）'],
  ['auto', '自动检测'],
  ['en', '英语'],
];

/** A saved secret is reusable only while the service behind it stays the same. */
function secretScope(value: WebAsrDraft | WebAsrService) {
  if (value.provider === 'openai') return `openai:${value.baseUrl}`;
  if (
    value.provider === 'whisper' ||
    value.provider === 'sense-voice' ||
    value.provider === 'browser'
  )
    return undefined;
  return `bailian:${value.region}:${value.workspaceId}`;
}

export function BailianAsrConfig({
  manager,
  disabled,
  models = ['default'],
  senseVoiceModels = ['default'],
}: {
  manager: ReturnType<typeof useAsrServices>;
  disabled: boolean;
  models?: string[];
  senseVoiceModels?: string[];
}) {
  const {
    draft,
    selected: saved,
    dirty,
    saving: busy,
    change,
    save,
    remove,
    reload,
  } = manager;
  const [editingKey, setEditingKey] = useState(false);
  useEffect(() => setEditingKey(false), [saved]);
  const savedScope =
    saved && 'hasApiKey' in saved && saved.hasApiKey
      ? secretScope(saved)
      : undefined;
  const hasSavedKey = savedScope !== undefined;
  const canKeepKey =
    savedScope !== undefined && savedScope === secretScope(draft);
  /** Cloud profiles keep one server-side secret per scope; blank keys reuse it. */
  const apiKeyEditor = (
    apiKey: string,
    placeholder: string,
    hints: { reset: string; initial: string },
  ) => (
    <div className="voice-key-field">
      <span className="voice-key-label">API Key</span>
      {canKeepKey && !editingKey ? (
        <div className="voice-key-saved">
          <span role="status">密钥已配置</span>
          <button type="button" onClick={() => setEditingKey(true)}>
            更换密钥
          </button>
        </div>
      ) : (
        <div className="voice-key-input">
          <input
            aria-label="API Key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder={placeholder}
            onChange={(e) => change({ apiKey: e.target.value })}
          />
          {canKeepKey && (
            <button
              type="button"
              onClick={() => {
                if (apiKey) change({ apiKey: '' });
                setEditingKey(false);
              }}
            >
              取消更换
            </button>
          )}
        </div>
      )}
      <small>
        {canKeepKey
          ? editingKey
            ? '留空保存仍使用已有密钥。'
            : '密钥已保存在服务端，不回显到浏览器。'
          : hasSavedKey
            ? hints.reset
            : hints.initial}
      </small>
    </div>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter;
        void save(
          submitter instanceof HTMLButtonElement &&
            submitter.value === 'add-another',
        );
      }}
    >
      <div className="console-panel-heading">
        <h3>{saved ? '编辑识别服务' : '添加识别服务'}</h3>
        <p>配置语音识别的语言、模型与参数；每份服务独立保存。</p>
      </div>
      <fieldset disabled={busy || disabled}>
        <label>
          服务名称
          <input
            required
            maxLength={50}
            value={draft.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <label>
          服务类型
          <select
            value={draft.provider ?? 'bailian'}
            disabled={!!saved}
            onChange={(e) =>
              manager.changeProvider(e.target.value as AsrProvider)
            }
          >
            <option value="whisper">自托管 Whisper</option>
            <option value="sense-voice">本地 SenseVoice（服务器离线）</option>
            <option value="bailian">阿里云百炼</option>
            <option value="openai">OpenAI 兼容接口（远程）</option>
            <option value="browser">浏览器语音识别（Web Speech API）</option>
          </select>
        </label>
        {draft.provider === 'browser' ? (
          <>
            <label>
              主要识别语言
              <select
                value={draft.language}
                onChange={(e) => change({ language: e.target.value })}
              >
                {browserLanguages.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <small>
              配置仅保存在当前浏览器，不会同步到其他设备；无需 API
              Key。每次选择一种主要语言，实际支持取决于浏览器识别服务。
            </small>
          </>
        ) : draft.provider === 'whisper' ? (
          <>
            <label>
              识别模型
              <select
                value={draft.model}
                onChange={(e) => change({ model: e.target.value })}
              >
                {[...new Set([...models, draft.model])].map((model) => (
                  <option key={model} value={model}>
                    {model === 'default' ? '服务器默认模型' : model}
                  </option>
                ))}
              </select>
            </label>
            <small>模型须已安装在服务器；更换模型后保存并检查服务状态。</small>
            <label>
              线程数
              <input
                type="number"
                min={1}
                max={16}
                required
                value={draft.threads}
                onChange={(e) => change({ threads: e.target.valueAsNumber })}
              />
            </label>
            <label>
              搜索宽度（Beam size）
              <input
                type="number"
                min={1}
                max={8}
                required
                value={draft.beamSize}
                onChange={(e) => change({ beamSize: e.target.valueAsNumber })}
              />
            </label>
            <label>
              采样温度
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                required
                value={draft.temperature}
                onChange={(e) =>
                  change({ temperature: e.target.valueAsNumber })
                }
              />
            </label>
            <label>
              提示词（可选）
              <textarea
                maxLength={500}
                rows={2}
                value={draft.prompt}
                placeholder="例如：人名、专业术语或预期文字风格"
                onChange={(e) => change({ prompt: e.target.value })}
              />
            </label>
          </>
        ) : draft.provider === 'sense-voice' ? (
          <>
            <label>
              识别模型
              <select
                value={draft.model}
                onChange={(e) => change({ model: e.target.value })}
              >
                {[...new Set([...senseVoiceModels, draft.model])].map(
                  (model) => (
                    <option key={model} value={model}>
                      {model === 'default' ? '服务器默认模型' : model}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              识别语言
              <select
                value={draft.language}
                onChange={(e) =>
                  change({
                    language: e.target.value as SenseVoiceLanguage,
                  })
                }
              >
                {senseVoiceLanguages.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <small>
              模型须已放在服务器项目目录的 models/
              下。识别在服务器进程内离线完成，不需要 API Key，也不会上传音频。
            </small>
          </>
        ) : draft.provider === 'openai' ? (
          <>
            <label>
              接口地址
              <input
                required
                maxLength={300}
                placeholder="https://api.openai.com/v1"
                value={draft.baseUrl}
                onChange={(e) => change({ baseUrl: e.target.value })}
              />
            </label>
            <label>
              识别模型
              <input
                required
                maxLength={100}
                placeholder="whisper-1"
                value={draft.model}
                onChange={(e) => change({ model: e.target.value })}
              />
            </label>
            {apiKeyEditor(
              draft.apiKey,
              canKeepKey ? '输入新密钥，保存后生效' : '填写服务端 API Key',
              {
                reset: '接口地址已更改，请重新填写密钥。',
                initial: '密钥仅保存在服务端；无需鉴权的自建服务可留空。',
              },
            )}
            <small>
              服务器把录音转发到该地址的 /audio/transcriptions 接口，兼容 OpenAI
              或任意同协议网关；音频会离开本项目服务器。
            </small>
          </>
        ) : (
          <>
            <label>
              服务地域
              <select
                value={draft.region}
                onChange={(e) =>
                  change({
                    region: e.target.value as BailianAsrDraft['region'],
                  })
                }
              >
                <option value="beijing">北京</option>
                <option value="singapore">新加坡</option>
              </select>
            </label>
            <label>
              业务空间 ID（可选）
              <input
                value={draft.workspaceId}
                maxLength={80}
                placeholder="留空使用公共接口"
                onChange={(e) => change({ workspaceId: e.target.value })}
              />
            </label>
            <label>
              识别模型
              <select
                value={draft.model}
                onChange={(e) =>
                  change({ model: e.target.value as BailianAsrDraft['model'] })
                }
              >
                <option value="fun-asr-realtime">Fun-ASR Realtime</option>
                <option value="paraformer-realtime-v2">
                  Paraformer Realtime v2
                </option>
              </select>
            </label>
            <div className="voice-key-field">
              <span className="voice-key-label">API Key</span>
              {canKeepKey && !editingKey ? (
                <div className="voice-key-saved">
                  <span role="status">密钥已配置</span>
                  <button type="button" onClick={() => setEditingKey(true)}>
                    更换密钥
                  </button>
                </div>
              ) : (
                <div className="voice-key-input">
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="new-password"
                    value={draft.apiKey}
                    placeholder={
                      canKeepKey ? '输入新密钥，保存后生效' : '填写百炼 API Key'
                    }
                    onChange={(e) => change({ apiKey: e.target.value })}
                  />
                  {canKeepKey && (
                    <button
                      type="button"
                      onClick={() => {
                        if (draft.apiKey) change({ apiKey: '' });
                        setEditingKey(false);
                      }}
                    >
                      取消更换
                    </button>
                  )}
                </div>
              )}
              <small>
                {canKeepKey
                  ? editingKey
                    ? '留空保存仍使用已有密钥。'
                    : '密钥已保存在服务端，不回显到浏览器。'
                  : hasSavedKey
                    ? '地域或业务空间已更改，请重新填写密钥。'
                    : '密钥仅保存在服务端，须与地域及业务空间匹配。'}
              </small>
            </div>
          </>
        )}
        <div className="voice-service-actions console-form-actions">
          <button
            className="primary"
            type="submit"
            disabled={!dirty || manager.loading}
          >
            {busy ? '处理中…' : '保存识别服务'}
          </button>
          {!saved && manager.canAddAnother && (
            <button
              type="submit"
              value="add-another"
              disabled={!dirty || manager.loading}
            >
              保存并继续添加
            </button>
          )}
          {saved && (
            <button type="button" onClick={() => void remove()}>
              删除服务
            </button>
          )}
          <button type="button" onClick={reload}>
            重新加载
          </button>
        </div>
      </fieldset>
      {dirty && <p className="agent-hint">请先保存修改，再开始录音。</p>}
      {draft.provider === 'browser' ? (
        <p className="agent-hint">
          浏览器直接进行麦克风识别，可能使用在线识别服务。保存后可在下方试用；聊天和附近语音使用服务器默认识别引擎。
        </p>
      ) : draft.provider === 'whisper' ? (
        <p className="agent-hint">
          录音与文件使用当前 Whisper
          配置在项目服务器识别。聊天和附近语音继续使用服务器默认配置。
        </p>
      ) : draft.provider === 'sense-voice' ? (
        <p className="agent-hint">
          录音与文件在项目服务器本地使用 SenseVoice
          离线识别，不经任何云端。服务器默认识别引擎由 ASR_PROVIDER
          控制，聊天与附近语音会跟随该默认值。
        </p>
      ) : draft.provider === 'openai' ? (
        <p className="agent-hint">
          录音与文件由项目服务器转发到该 OpenAI
          兼容接口识别，按服务商规则计费；音频会离开本项目服务器。此处选择用于
          ASR 试用；聊天和附近语音使用服务器默认识别引擎。
        </p>
      ) : (
        <>
          <p className="agent-hint">
            录音经项目服务器发送给阿里云，按服务商规则计费。此处选择用于 ASR
            试用；聊天和附近语音使用服务器默认识别引擎（默认优先本地
            SenseVoice，否则 Whisper）。
          </p>
          <a
            className="console-help-link"
            href="https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide"
            target="_blank"
            rel="noreferrer"
          >
            阿里云接入文档 ↗
          </a>
        </>
      )}
    </form>
  );
}
