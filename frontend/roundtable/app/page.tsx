'use client';

import { useState, useEffect, useRef } from 'react';
import { useRoundtableAudio } from '../lib/audio/useRoundtableAudio';
import type { CalibTurnMsg } from '../lib/audio/types';

export default function RoundtableTest() {
  const [name, setName] = useState('Participant 1');
  // Note: This WebSocket will fail to connect until your Python backend is built, 
  // but the microphone and Web Speech API will still initialize locally.
  const [wsUrl, setWsUrl] = useState('ws://localhost:8000/ws/room'); 

  // 1. Initialize the audio client hook
  const {
    status, conn, asrStatus, mode, error, meter, start, stop
  } = useRoundtableAudio({
    wsUrl,
    name,
    onServerMessage: (m) => console.log('Server message:', m),
    onCalibTurn: (m: CalibTurnMsg, mine: boolean) => {
      console.log('Calibration turn:', m, 'Is mine?', mine);
    }
  });

  // 2. High-performance meter rendering loop (bypasses React state)
  const meterFillRef = useRef<HTMLDivElement>(null);
  const floorMarkerRef = useRef<HTMLDivElement>(null);
  const vadIndicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frameId: number;
    const renderMeter = () => {
      if (meter.current) {
        // Map -100dB -> 0dB to 0% -> 100%
        const dbPercent = Math.max(0, Math.min(100, meter.current.db + 100));
        const floorPercent = Math.max(0, Math.min(100, meter.current.floor + 100));
        
        if (meterFillRef.current) {
          meterFillRef.current.style.width = `${dbPercent}%`;
          // Turn green when VAD detects speech
          meterFillRef.current.style.backgroundColor = meter.current.vad ? '#3ddc97' : '#6d5efc';
        }
        if (floorMarkerRef.current) {
          floorMarkerRef.current.style.left = `${floorPercent}%`;
        }
        if (vadIndicatorRef.current) {
          vadIndicatorRef.current.style.opacity = meter.current.vad ? '1' : '0.2';
          vadIndicatorRef.current.style.boxShadow = meter.current.vad ? '0 0 10px #3ddc97' : 'none';
        }
      }
      frameId = requestAnimationFrame(renderMeter);
    };
    
    // Only run the loop if we are live
    if (status === 'live') {
      frameId = requestAnimationFrame(renderMeter);
    }
    return () => cancelAnimationFrame(frameId);
  }, [status, meter]);

  return (
    <main className="min-h-screen bg-[#0b0d12] text-[#e8eaf0] font-sans p-6 flex flex-col items-center justify-center">
      <div className="w-full max-w-md bg-[#121620] p-6 rounded-2xl shadow-2xl border border-neutral-800">
        <h1 className="text-2xl font-bold mb-6 text-center text-white">Roundtable Dev</h1>

        {/* Controls */}
        <div className="space-y-4 mb-8">
          <div>
            <label className="block text-sm text-neutral-400 mb-1">Your Name</label>
            <input 
              type="text" 
              value={name} 
              onChange={(e) => setName(e.target.value)}
              disabled={status !== 'idle'}
              className="w-full bg-[#1b1f2a] border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-[#6d5efc]"
            />
          </div>
          <div>
            <label className="block text-sm text-neutral-400 mb-1">WebSocket URL</label>
            <input 
              type="text" 
              value={wsUrl} 
              onChange={(e) => setWsUrl(e.target.value)}
              disabled={status !== 'idle'}
              className="w-full bg-[#1b1f2a] border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-[#6d5efc]"
            />
          </div>
          
          <button
            onClick={status === 'idle' ? start : stop}
            className={`w-full py-4 rounded-xl font-bold transition-all ${
              status === 'idle' 
                ? 'bg-[#6d5efc] hover:bg-[#5b4df0] text-white' 
                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            }`}
          >
            {status === 'idle' ? 'Join Session' : 'Leave Session'}
          </button>
        </div>

        {error && (
          <div className="p-3 mb-6 bg-red-500/10 border border-red-500/50 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Live Diagnostics */}
        <div className="space-y-4 bg-[#1b1f2a] p-5 rounded-xl">
          <div className="flex justify-between items-center text-sm">
            <span className="text-neutral-400">Mic Status</span>
            <span className="font-mono">{status}</span>
          </div>
          
          <div className="flex justify-between items-center text-sm">
            <span className="text-neutral-400">WebSocket</span>
            <span className={`font-mono ${conn === 'open' ? 'text-[#3ddc97]' : 'text-yellow-400'}`}>
              {conn}
            </span>
          </div>

          <div className="flex justify-between items-center text-sm">
            <span className="text-neutral-400">Web Speech API</span>
            <span className="font-mono">{asrStatus} ({mode})</span>
          </div>

          <div className="pt-4 border-t border-neutral-800">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-neutral-400">Live Level & VAD</span>
              <div 
                ref={vadIndicatorRef}
                className="w-3 h-3 rounded-full bg-[#3ddc97] opacity-20 transition-all duration-75"
              />
            </div>
            
            {/* Audio Meter */}
            <div className="relative w-full h-4 bg-[#0b0d12] rounded-full overflow-hidden">
              <div 
                ref={meterFillRef}
                className="absolute top-0 left-0 h-full w-0 transition-all duration-75 rounded-full"
              />
              <div 
                ref={floorMarkerRef}
                className="absolute top-0 bottom-0 w-0.5 bg-red-500/80 -ml-px"
                style={{ left: '0%' }}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}