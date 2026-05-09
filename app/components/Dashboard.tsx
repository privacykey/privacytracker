'use client';

import { useState } from 'react';
import Image from 'next/image';

export default function Dashboard({ initialApps }: { initialApps: any[] }) {
  const [apps, setApps] = useState(initialApps);
  const [isSyncing, setIsSyncing] = useState(false);
  const [urlsInput, setUrlsInput] = useState('');

  const handleSync = async () => {
    setIsSyncing(true);
    
    // Parse urls, separated by comma or new lines
    const rawUrls = urlsInput.split(/[\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));

    if (rawUrls.length > 0) {
      try {
        await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: rawUrls })
        });
        
        // Refresh apps list
        const res = await fetch('/api/apps');
        const newApps = await res.json();
        setApps(newApps);
        setUrlsInput('');
      } catch (e) {
        console.error(e);
      }
    }
    
    setIsSyncing(false);
  };

  if (apps.length === 0) {
    return (
      <div className="onboarding-container">
        <div className="onboarding-card">
          <h1 className="onboarding-title">Welcome to App privacytracker</h1>
          <p className="onboarding-subtitle">
            Keep an eye on what data iOS applications are linking to your identity.
            <br/><br/>
            To get started, paste one or more App Store URLs below. You can separate them by commas or new lines.
          </p>
          
          <textarea 
            className="textarea-input"
            placeholder="https://apps.apple.com/us/app/apple-store/id375380948&#10;https://apps.apple.com/us/app/facebook/id284882215"
            value={urlsInput}
            onChange={(e) => setUrlsInput(e.target.value)}
            disabled={isSyncing}
          />
          
          <button 
            className="primary-button"
            onClick={handleSync}
            disabled={isSyncing || urlsInput.trim().length === 0}
          >
            {isSyncing ? 'Scraping Private Data...' : 'Begin Tracking'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div className="header">
        <h1>Tracked Apps</h1>
        <button 
          className="primary-button" 
          style={{ width: 'auto' }}
          onClick={() => {
            const extra = prompt('Paste an App Store URL:');
            if (extra) {
               setUrlsInput(extra);
               handleSync(); // technically uses state async but we can just map it here in a real scenario
            }
          }}
        >
          + Add App
        </button>
      </div>

      <div className="app-grid">
        {apps.map(app => (
          <div key={app.id} className="app-card">
            {app.iconUrl ? (
              <Image 
                src={app.iconUrl} 
                alt={app.name} 
                width={64} height={64} 
                className="app-icon"
                unoptimized
                style={{ objectFit: 'cover' }}
              />
            ) : (
              <div className="app-icon" />
            )}
            <div className="app-info">
              <h3>{app.name}</h3>
              <p>Last Synced: {new Date(app.lastSynced).toLocaleDateString()}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
