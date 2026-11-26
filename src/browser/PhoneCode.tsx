/**
 * The phone side of the typed code (phone-pairing.ts `redeemOffer`): for a phone that cannot scan the QR code. The person
 * types the ten characters the computer shows; the code never leaves this page, only a lookup made from it does. What comes
 * back opens the same "Connect this phone to your rooms?" page a scan opens.
 */
import { useRef, useState, type ReactNode } from 'react';
import { OFFER_ALPHABET, OFFER_CODE_LENGTH, showOfferCode } from './pairing';
import { redeemOffer, type PairCommander, type PhoneLink } from './phone-pairing';

/** What the field holds as it is typed: upper case, Crockford's look-alikes folded, XXXXX-XXXXX. */
export function typedOfferCode(text: string) {
  const letters = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').split('').filter(c => OFFER_ALPHABET.includes(c)).slice(0, OFFER_CODE_LENGTH).join('');
  return letters.length > 5 ? showOfferCode(letters) : letters;
}

export function PhoneCode({ command, onLink, defaultOpen }: { command: PairCommander; onLink(link: PhoneLink): void; defaultOpen?: boolean }): ReactNode {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const details = useRef<HTMLDetailsElement>(null);
  const ready = code.replace('-', '').length === OFFER_CODE_LENGTH;
  async function submit() {
    if (busy || !ready) return;
    setBusy(true); setProblem('');
    try { onLink(await redeemOffer(code, command)); }
    catch (error) { setProblem((error as Error).message || 'Couldn’t reach Meshrooms. Try again.'); }
    finally { setBusy(false); }
  }
  return <details className="phone-code-entry" ref={details} open={defaultOpen}>
    <summary>Connect this phone with a code</summary>
    <form className="phone-code-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <p className="invite-lead invite-muted">On your computer, open <strong>Invite</strong>, then <strong>My phone</strong>, then <strong>Type a code instead</strong>. Type what it shows.</p>
      <label>Code from your computer
        <input value={code} onChange={e => { setCode(typedOfferCode(e.target.value)); setProblem(''); }} inputMode="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
          placeholder="XXXXX-XXXXX" maxLength={OFFER_CODE_LENGTH + 1} aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'phone-code-problem' : undefined} /></label>
      {problem && <p id="phone-code-problem" className="browser-error" role="alert">{problem}</p>}
      <button className="primary" disabled={busy || !ready}>{busy ? 'Checking…' : 'Continue'}</button>
    </form>
  </details>;
}
