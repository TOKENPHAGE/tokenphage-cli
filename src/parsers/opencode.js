import { readFile } from 'fs/promises';
import { localDateOf } from '../lib/dates.js';

// opencode(sst) 세션 저장 파서.
// opencode는 턴당 assistant 메시지 1개에 스텝마다 tokens를 덮어써(=) 마지막 스텝만 남기므로,
// 스텝별 토큰이 보존된 step-finish part(storage/part/<messageID>/*.json)를 전부 합산해야 정확하다.
// 전략:
//  - message(role==='assistant')에서 id→{model, date}를 모으고, step-finish part를 messageID로 조인한다.
//  - 입력 파일 목록에 message/part가 섞여 오고 순서 보장이 없으므로, 두 맵을 모은 뒤 마지막에 조인한다.
//  - 필드 매핑(claude/codex와 정합): opencode getUsage가 input은 캐시 제외로, output은 reasoning 제외로
//    저장하므로 → inputTok은 그대로, outputTok은 output+reasoning으로 reasoning을 되살린다.
//    cache.write는 cacheCreate로 둔다(opencode는 Anthropic cacheCreation을 여기 담는다).
//  - 손상 파일·부모 없는 part·모델/날짜 없는 메시지는 집계에서 제외한다.

// step-finish part의 tokens를 tokenphage 레코드 4필드로 매핑한다. 음수 방어로 max(…,0).
function entryOf(date, model, tokens) {
  const cache = tokens.cache ?? {};
  return {
    date,
    model,
    inputTok: Math.max(tokens.input ?? 0, 0),
    // opencode는 output에서 reasoning을 미리 뺐으므로 되살려 청구 기준(claude/codex)과 맞춘다.
    outputTok: Math.max(tokens.output ?? 0, 0) + Math.max(tokens.reasoning ?? 0, 0),
    cacheReadTok: Math.max(cache.read ?? 0, 0),
    cacheCreateTok: Math.max(cache.write ?? 0, 0),
  };
}

/**
 * opencode message/part 파일들을 스텝(step-finish) 단위 usage 목록으로 파싱한다.
 * @param {string[]} files 메시지·파트 JSON 파일 경로 목록 (섞여 있어도 됨)
 * @returns {Promise<Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>>}
 */
export async function parseOpencodeFiles(files) {
  const messageMeta = new Map(); // messageID → { model, date }
  const stepParts = [];          // { messageID, tokens }

  for (const file of files) {
    let obj;
    try {
      obj = JSON.parse(await readFile(file, 'utf8'));
    } catch { continue; } // 읽기 실패·손상 JSON skip
    if (!obj) continue;

    if (obj.role === 'assistant') {
      // 모델·날짜를 못 만들면 이 메시지의 파트는 귀속 불가 → 맵에 넣지 않는다.
      if (!obj.id || !obj.modelID) continue;
      const date = localDateOf(obj.time?.created);
      if (!date) continue;
      messageMeta.set(obj.id, { model: obj.modelID, date });
    } else if (obj.type === 'step-finish') {
      if (!obj.messageID || !obj.tokens) continue;
      stepParts.push({ messageID: obj.messageID, tokens: obj.tokens });
    }
    // 그 외(user 메시지, 다른 part, session/project 파일)는 무시
  }

  const entries = [];
  for (const part of stepParts) {
    const meta = messageMeta.get(part.messageID);
    if (!meta) continue; // 부모 메시지 없음/모델·날짜 무효 → skip
    entries.push(entryOf(meta.date, meta.model, part.tokens));
  }
  return entries;
}
