import { createRoot } from 'react-dom/client';
import { FirstRun } from './FirstRun';
import { BrowserRooms } from './browser/BrowserRooms';
import { LocalSource } from './browser/local-source';
import '@fontsource-variable/manrope';
import './style.css';

// The browser ticket belongs in memory only, never in subsequent links or requests.
const entry = new URL(location.href);
const fragment = new URLSearchParams(entry.hash.slice(1));
const accessTicket = fragment.get('access');
if (fragment.has('access')) { entry.hash = ''; history.replaceState(null, '', entry); }

// The page the desktop app serves (its local API marks it), or a build made for it: a thin client of the person device.
const local = document.querySelector('meta[name="meshrooms-source"]')?.getAttribute('content') === 'local' || import.meta.env.VITE_MESHROOMS_SOURCE === 'local';
if (local && entry.pathname === '/') { entry.pathname = '/rooms'; history.replaceState(null, '', entry); }
const browserRoom = entry.pathname === '/rooms' || /^\/r\/[a-f0-9-]{36}$/.test(entry.pathname);
const root = createRoot(document.getElementById('root')!);
if (local) root.render(<BrowserRooms source={new LocalSource(accessTicket)} />);
else root.render(browserRoom ? <BrowserRooms /> : <FirstRun accessTicket={accessTicket} />);
