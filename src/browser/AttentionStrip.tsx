import type { Task } from '../collab';
import { attentionCount, finishOf, type Attention } from './attention';
import type { Decision } from './decisions';

const ICONS = {
  mention: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>,
  vote: <path d="M4 21h16M6 17V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v12M9 10l2 2 4-4" />,
  review: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5.5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
};
const Icon = ({ kind }: { kind: keyof typeof ICONS }) =>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[kind]}</svg>;

/**
 * What in this room waits on the person, above the conversation: messages for them, decisions waiting for their vote
 * and finished tasks of theirs to review. Each item opens the oldest one; the strip leaves once nothing is waiting.
 */
export function AttentionStrip({ attention, nameOf, onMessage, onDecision, onTask, onClear }: {
  attention: Attention; nameOf: (memberId: string) => string;
  onMessage: (id: string) => void; onDecision: (decision: Decision) => void; onTask: (task: Task) => void; onClear: () => void;
}) {
  const total = attentionCount(attention);
  if (!total) return null;
  const { messages, decisions, tasks } = attention;
  const [message] = messages, [decision] = decisions, [task] = tasks;
  return <section className="browser-attention" aria-labelledby="browser-attention-title">
    <div className="browser-attention-inner">
      <h2 id="browser-attention-title" className="browser-attention-title">
        <span className="browser-attention-signal" aria-hidden="true" />Needs you
        <span className="browser-attention-count" key={total}><span className="sr-only">: </span>{total}</span>
      </h2>
      <ul className="browser-attention-items">
        {message && <li className="is-message"><button type="button" title={messages.length > 1 ? `${messages.length} messages for you: show the oldest` : `${message.how === 'mention' ? 'Mention' : 'Reply'} from ${nameOf(message.memberId)}: show the message`} onClick={() => onMessage(message.id)}>
          <Icon kind="mention" />
          <span>{messages.length > 1 ? `${messages.length} messages for you` : `${message.how === 'mention' ? 'Mention' : 'Reply'} from ${nameOf(message.memberId)}`}</span>
        </button></li>}
        {decision && <li><button type="button" title={decisions.length > 1 ? `${decisions.length} decisions need your vote: show the one closing soonest` : `Vote on “${decision.question}”`} onClick={() => onDecision(decision)}>
          <Icon kind="vote" />
          <span>{decisions.length > 1 ? `${decisions.length} decisions need your vote` : <>Vote on <q>{decision.question}</q></>}</span>
        </button></li>}
        {task && <li><button type="button" title={tasks.length > 1 ? `${tasks.length} finished tasks to review: show the oldest on the task board` : `Review “${task.title}”, done by ${nameOf(finishOf(task).by)}: show it on the task board`} onClick={() => onTask(task)}>
          <Icon kind="review" />
          <span>{tasks.length > 1 ? `${tasks.length} finished tasks to review` : <>Review <q>{task.title}</q><small> · done by {nameOf(finishOf(task).by)}</small></>}</span>
        </button></li>}
      </ul>
      <button type="button" className="browser-attention-clear" title="Clear all" aria-label="Clear all" onClick={onClear}><Icon kind="close" /></button>
    </div>
  </section>;
}
