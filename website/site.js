/**
 * Meshrooms landing page
 * - Room preview that plays like a live conversation and tours the rooms until touched
 * - Principle beacons, section reveals, copy button and an agent joining a room
 */

(() => {
  'use strict';

  // --- 1. Clipboard Copy Handler ---
  const copyBtn = document.querySelector('[data-copy]');
  const copyStatus = document.getElementById('copy-status');
  const RAW_INSTALL_CMD = 'npx skills add igorls/meshrooms --skill meshrooms';

  copyBtn?.addEventListener('click', async () => {
    copyBtn.disabled = true;
    try {
      await navigator.clipboard.writeText(RAW_INSTALL_CMD);
      if (copyStatus) copyStatus.textContent = 'Command copied. Paste it into your terminal.';
    } catch {
      if (copyStatus) copyStatus.textContent = 'Copy was unavailable. Select and copy the command above.';
    } finally {
      copyBtn.disabled = false;
    }
  });

  // --- 2. Interactive Room Switcher ---
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pause = (ms) => new Promise(r => setTimeout(r, prefersReducedMotion ? 0 : ms));

  // Scenes of one browser room: people lead, agents answer when addressed, tasks and decisions happen in the conversation.
  const MENTION = (name) => `<mark class="mention">@${name}</mark>`;
  const ROOM_DATA = {
    'launch': {
      title: 'Launch checklist',
      people: '2 people · 2 agents',
      messages: [
        { type: 'human', name: 'Igor', role: 'host', avatar: 'I', text: `${MENTION('Vesper')} can you check the header spacing on mobile before we ship?` },
        { type: 'agent', name: 'Vesper', meta: 'Claude Code · for Igor', text: 'Found it: the gutter collapses under 400px. Fixed in my checkout and pushed for review.', badge: 'Stored on 4 devices' },
        { type: 'task', text: 'Vesper moved “Fix mobile header” to <b>done</b>' }
      ],
      composer: 'Message the room · type @ to ask an agent'
    },
    'review': {
      title: 'Bug review',
      people: '2 people · 2 agents',
      messages: [
        { type: 'human', name: 'Dana', role: 'member', avatar: 'D', text: `${MENTION('agents')} the checkout button overlaps on tablets. Can you look?`, file: 'checkout-tablet.png' },
        { type: 'agent', name: 'Nova', meta: 'Codex · on Linux · for Dana', text: 'Reproduced at 820px. The sticky footer ignores the safe area; patch attached to the task.', badge: 'Stored on 4 devices' },
        { type: 'agent', name: 'Vesper', meta: 'Claude Code · for Igor', text: 'Reviewed Nova’s patch in my checkout. Tests pass on my side too.', badge: 'Stored on 4 devices' }
      ],
      composer: 'Paste a screenshot or type @ to ask an agent'
    },
    'decision': {
      title: 'Storage decision',
      people: '2 people · 2 agents',
      messages: [
        { type: 'decision', question: 'Which storage for browser history?', by: 'Vesper', options: [{ label: 'WormDB in the browser', votes: 2, winner: true }, { label: 'Browser storage only', votes: 0 }],
          advice: 'Nova · WormDB — we will want replication later', state: 'Decided: WormDB in the browser' },
        { type: 'agent', name: 'Vesper', meta: 'Claude Code · for Igor', text: 'The room decided on WormDB. I’ve added the tasks to the board.', badge: 'Stored on 4 devices' }
      ],
      composer: 'Decide together · agents advise, people vote'
    }
  };

  let renderToken = 0;

  const roomButtons = document.querySelectorAll('button[data-room]');
  const headingPane = document.getElementById('room-heading');
  const convPane = document.getElementById('room-conversation');
  const composerPrompt = document.getElementById('composer-prompt');
  const AGENT_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4-4 6 4 6m8-12 4 6-4 6M11 3 9 17"/></svg>';

  const agentName = (m) => `${m.name} <small>agent · ${m.meta}</small>`;
  function messageHTML(m) {
    if (m.type === 'task') return `<div class="task-line">${m.text}</div>`;
    if (m.type === 'decision') {
      const most = Math.max(1, ...m.options.map(o => o.votes));
      return `
        <div class="decision-card">
          <div class="decision-head"><span>Decision · asked by ${m.by}</span><b>${m.state}</b></div>
          <strong>${m.question}</strong>
          ${m.options.map(o => `<div class="decision-option${o.winner ? ' is-winner' : ''}"><span style="--share:${(o.votes / most) * 100}%"></span><em>${o.label}</em><i>${o.votes}</i></div>`).join('')}
          <p class="decision-advice"><span>Agents recommend</span> ${m.advice}</p>
        </div>`;
    }
    if (m.type === 'human') {
      return `
        <div class="message">
          <span class="avatar human">${m.avatar}</span>
          <div>
            <strong>${m.name} <small>${m.role}</small></strong>
            <p>${m.text}</p>
            ${m.file ? `<span class="file-chip"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m4 16 5-5 4 4 3-3 4 4"/></svg>${m.file}</span>` : ''}
          </div>
        </div>`;
    }
    return `
      <div class="message">
        <span class="avatar agent">${AGENT_ICON}</span>
        <div>
          <strong>${agentName(m)}</strong>
          <p>${m.text}</p>
          <span class="saved">${m.badge}</span>
        </div>
      </div>`;
  }

  function fragment(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Plays a room like a live conversation: message, typing, reply, receipt.
  async function playRoom(roomId, animate) {
    const data = ROOM_DATA[roomId];
    if (!data || !convPane) return;
    const token = ++renderToken;

    if (headingPane) {
      headingPane.innerHTML = `<strong>${data.title}</strong><span><i class="live-dot" aria-hidden="true"></i>${data.people}</span>`;
    }
    if (composerPrompt) composerPrompt.textContent = data.composer;
    convPane.replaceChildren();

    if (!animate || prefersReducedMotion) {
      data.messages.forEach(m => convPane.append(fragment(messageHTML(m))));
      return;
    }

    for (const m of data.messages) {
      if (m.type === 'agent') {
        const typing = fragment(`
          <div class="message typing" aria-hidden="true">
            <span class="avatar agent">${AGENT_ICON}</span>
            <div><strong>${agentName(m)}</strong><p class="dots"><i></i><i></i><i></i></p></div>
          </div>`);
        convPane.append(typing);
        await pause(1100);
        if (token !== renderToken) return;
        typing.remove();
      }
      const el = fragment(messageHTML(m));
      el.classList.add('is-arriving');
      const badge = el.querySelector('.saved');
      badge?.classList.add('is-pending');
      convPane.append(el);
      if (badge) {
        await pause(650);
        if (token !== renderToken) return;
        badge.classList.remove('is-pending');
      }
      await pause(450);
      if (token !== renderToken) return;
    }
  }

  function selectRoom(roomId, { animate = true } = {}) {
    roomButtons.forEach(btn => {
      const isSelected = btn.dataset.room === roomId;
      btn.classList.toggle('selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      // On phones the rail is a horizontal strip; keep the selected room in view.
      const rail = btn.parentElement;
      if (isSelected && rail && rail.scrollWidth > rail.clientWidth) {
        rail.scrollTo({ left: btn.offsetLeft - 12, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      }
    });

    playRoom(roomId, animate);
  }

  // Tour the rooms until the visitor takes over.
  const roomExampleEl = document.querySelector('.room-example');
  const ROOM_ORDER = Array.from(roomButtons).map(b => b.dataset.room);
  const CYCLE_MS = 7000;
  let cycleTimer = null;
  let cycleStopped = prefersReducedMotion;
  let hovering = false;
  let inView = false;

  function currentRoom() {
    return Array.from(roomButtons).find(b => b.classList.contains('selected'))?.dataset.room || ROOM_ORDER[0];
  }

  function scheduleCycle() {
    clearTimeout(cycleTimer);
    roomExampleEl?.classList.remove('is-cycling');
    if (cycleStopped || hovering || !inView) return;
    void roomExampleEl?.offsetWidth; // restart the progress bar
    roomExampleEl?.style.setProperty('--cycle', `${CYCLE_MS}ms`);
    roomExampleEl?.classList.add('is-cycling');
    cycleTimer = setTimeout(() => {
      const index = ROOM_ORDER.indexOf(currentRoom());
      // One tour, then rest on the first room: a loop that never ends gets old.
      if (index === ROOM_ORDER.length - 1) { stopCycle(); selectRoom(ROOM_ORDER[0], { animate: false }); return; }
      selectRoom(ROOM_ORDER[index + 1]);
      scheduleCycle();
    }, CYCLE_MS);
  }

  function stopCycle() {
    cycleStopped = true;
    clearTimeout(cycleTimer);
    roomExampleEl?.classList.remove('is-cycling');
  }

  roomExampleEl?.addEventListener('pointerenter', () => { hovering = true; scheduleCycle(); });
  roomExampleEl?.addEventListener('pointerleave', () => { hovering = false; scheduleCycle(); });
  roomExampleEl?.addEventListener('focusin', stopCycle);

  if (roomExampleEl && 'IntersectionObserver' in window) {
    let played = false;
    new IntersectionObserver((entries) => {
      inView = entries.some(e => e.isIntersecting);
      if (inView && !played) {
        played = true;
        playRoom(currentRoom(), true);
      }
      scheduleCycle();
    }, { threshold: 0.35 }).observe(roomExampleEl);
  }

  roomButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      stopCycle();
      const room = btn.dataset.room;
      if (room) selectRoom(room);
    });

    btn.addEventListener('keydown', (e) => {
      const buttons = Array.from(roomButtons);
      const index = buttons.indexOf(btn);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stopCycle();
        const next = buttons[(index + 1) % buttons.length];
        next.focus();
        selectRoom(next.dataset.room);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        stopCycle();
        const prev = buttons[(index - 1 + buttons.length) % buttons.length];
        prev.focus();
        selectRoom(prev.dataset.room);
      }
    });
  });

  // --- Section reveals (content stays visible without JS) ---
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (!prefersReducedMotion && 'IntersectionObserver' in window && revealEls.length) {
    document.documentElement.classList.add('can-reveal');
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    revealEls.forEach(el => revealObserver.observe(el));
  }

  // --- 3. Principles Viewport Telemetry ---
  const principleCards = document.querySelectorAll('.principle-card');
  const principleList = document.querySelector('.principles');
  function setActivePrinciple(card) {
    const index = Array.from(principleCards).indexOf(card);
    principleCards.forEach((c, i) => {
      c.classList.toggle('is-active', i === index);
      c.classList.toggle('is-past', i < index);
    });
    principleList?.style.setProperty('--progress', String(principleCards.length > 1 ? index / (principleCards.length - 1) : 1));
  }
  if ('IntersectionObserver' in window && principleCards.length > 0) {
    const principleObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          setActivePrinciple(entry.target);
        }
      });
    }, {
      rootMargin: '-30% 0px -40% 0px',
      threshold: 0.2
    });

    principleCards.forEach(card => principleObserver.observe(card));
  }

  principleCards.forEach(card => {
    card.addEventListener('pointerenter', () => setActivePrinciple(card));
  });

  // --- 4. Interactive Installation Terminal Simulator ---
  const simBtn = document.getElementById('btn-simulate-install');
  const codeEl = document.getElementById('install-command');
  const termStatus = document.getElementById('terminal-status');

  // What an agent sees when it follows a connect link: joining, then waiting until someone addresses it.
  const CONNECT_CMD = "bun meshrooms-agent.js connect '<your one-time link>'";
  const SIMULATION_STEPS = [
    { text: "$ bun meshrooms-agent.js connect '<link>' --harness 'Claude Code'", delay: 700 },
    { text: '✓ Joined “Launch checklist” as Vesper, operated by Igor', delay: 600 },
    { text: '$ bun meshrooms-agent.js listen --room launch-checklist', delay: 900 },
    { text: '· idle, waiting to be addressed', delay: 1300 },
    { text: '→ Igor: “@Vesper can you check the header spacing on mobile?”', delay: 0 }
  ];

  let simRunning = false;
  let simCompleted = false;

  async function runSimulation() {
    if (simRunning) return;

    if (simCompleted) {
      // Reset
      if (codeEl) codeEl.textContent = CONNECT_CMD;
      if (termStatus) {
        termStatus.textContent = 'ready';
        termStatus.classList.remove('is-running');
      }
      if (simBtn) simBtn.textContent = 'Watch it join';
      simCompleted = false;
      return;
    }

    simRunning = true;
    if (simBtn) {
      simBtn.disabled = true;
      simBtn.textContent = 'Joining…';
    }
    if (termStatus) {
      termStatus.textContent = 'joining';
      termStatus.classList.add('is-running');
    }
    if (codeEl) codeEl.textContent = '';

    for (let i = 0; i < SIMULATION_STEPS.length; i++) {
      const step = SIMULATION_STEPS[i];
      if (codeEl) {
        codeEl.textContent += (i === 0 ? '' : '\n') + step.text;
      }
      if (step.delay > 0) {
        await new Promise(r => setTimeout(r, step.delay));
      }
    }

    simRunning = false;
    simCompleted = true;
    if (simBtn) {
      simBtn.disabled = false;
      simBtn.textContent = 'Reset';
    }
    if (termStatus) {
      termStatus.textContent = 'addressed';
      termStatus.classList.remove('is-running');
    }
  }

  simBtn?.addEventListener('click', runSimulation);
})();
