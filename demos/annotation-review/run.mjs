import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// This offline demo creates a review queue. It never claims to have changed a website.
export function reviewQueue(input) {
  if (!input.sessionId || !Array.isArray(input.annotations)) throw Error('A session and annotations are required');
  const seen = new Set();
  return input.annotations.map(a => {
    if (!a.id || seen.has(a.id) || typeof a.comment !== 'string' || !a.comment.trim()) throw Error('Invalid or duplicate annotation');
    seen.add(a.id);
    const actionable = a.kind === 'feedback' && a.intent === 'fix' && typeof a.elementPath === 'string' && a.elementPath.trim();
    return {sessionId:input.sessionId,annotationId:a.id,feedback:a.comment,elementPath:a.elementPath??null,nextAction:actionable?'inspect-and-propose':'ask-for-clarification',status:'pending',evidence:[]};
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2] ?? new URL('./input.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(reviewQueue(input),null,2));
}
