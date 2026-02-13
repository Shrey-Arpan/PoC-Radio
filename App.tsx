import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { 
  Mic, 
  MicOff, 
  Settings, 
  History, 
  Signal, 
  Wifi, 
  Battery, 
  ShieldAlert, 
  Users, 
  Bot, 
  Link as LinkIcon, 
  RefreshCw 
} from 'lucide-react';
import { Peer, MediaConnection } from 'peerjs';

// --- Types & Constants ---
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type PTTStatus = 'idle' | 'transmitting' | 'receiving';
type AppMode = 'dispatch' | 'human';

const SYSTEM_INSTRUCTION = `You are a professional radio dispatcher callsign "BASE-1".
The user is "UNIT-7". 
Always respond in radio lingo. Keep it short. 
Example: "UNIT-7, this is BASE-1. Copy that, proceed with caution. Over."`;

// --- Utility Functions ---
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function createPCMBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encodeBase64(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// --- Main App Component ---
const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('dispatch');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [pttStatus, setPttStatus] = useState<PTTStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [myPeerId, setMyPeerId] = useState<string>('');
  const [targetPeerId, setTargetPeerId] = useState<string>('');
  const [isPeerLinked, setIsPeerLinked] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const currentCallRef = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // --- Initialize P2P ---
  useEffect(() => {
    const randomId = Math.floor(1000 + Math.random() * 9000).toString();
    const peer = new Peer(`POC-${randomId}`);
    
    peer.on('open', (id) => {
      setMyPeerId(id.replace('POC-', ''));
    });

    peer.on('call', (call) => {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        localStreamRef.current = stream;
        stream.getAudioTracks().forEach(t => t.enabled = false);
        call.answer(stream);
        setupIncomingCall(call);
        setIsPeerLinked(true);
        setAppMode('human');
        setConnectionStatus('connected');
      }).catch(() => setErrorMessage("Mic permission denied."));
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') setErrorMessage("Unit offline.");
      setConnectionStatus('disconnected');
    });

    peerRef.current = peer;
    return () => peer.destroy();
  }, []);

  const setupIncomingCall = (call: MediaConnection) => {
    currentCallRef.current = call;
    call.on('stream', (remoteStream) => {
      audioRef.current.srcObject = remoteStream;
      audioRef.current.play().catch(e => console.error("Playback failed", e));
      
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(remoteStream);
      const analyser = ctx.createAnalyser();
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      const checkVolume = () => {
        if (!currentCallRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
        if (volume > 5 && pttStatus !== 'transmitting') {
          setPttStatus('receiving');
        } else if (pttStatus === 'receiving' && volume <= 5) {
          setPttStatus('idle');
        }
        requestAnimationFrame(checkVolume);
      };
      checkVolume();
    });
    call.on('close', () => {
      setIsPeerLinked(false);
      setConnectionStatus('disconnected');
    });
  };

  const linkToPeer = async () => {
    if (!targetPeerId || !peerRef.current) return;
    setConnectionStatus('connecting');
    setErrorMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach(t => t.enabled = false);
      const call = peerRef.current.call(`POC-${targetPeerId}`, stream);
      if (call) {
        setupIncomingCall(call);
        setIsPeerLinked(true);
        setConnectionStatus('connected');
      }
    } catch (err) {
      setErrorMessage("Microphone is required.");
      setConnectionStatus('error');
    }
  };

  // --- Gemini Live Session ---
  const connectToGemini = useCallback(async () => {
    if (connectionStatus === 'connecting' || connectionStatus === 'connected') return;
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setErrorMessage("Missing API Key in Netlify.");
      return;
    }

    setConnectionStatus('connecting');
    setErrorMessage(null);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AC({ sampleRate: 16000 });
      outputAudioContextRef.current = new AC({ sampleRate: 24000 });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION
        },
        callbacks: {
          onopen: () => setConnectionStatus('connected'),
          onmessage: async (message: LiveServerMessage) => {
            const data = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (data && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              setPttStatus('receiving');
              const buffer = await decodeAudioData(decodeBase64(data), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setPttStatus('idle');
              };
              source.start();
              sourcesRef.current.add(source);
            }
          },
          onclose: () => setConnectionStatus('disconnected'),
          onerror: () => setConnectionStatus('error')
        }
      });
      sessionPromiseRef.current = sessionPromise;
      await sessionPromise;
    } catch (err) {
      setErrorMessage("Link failed.");
      setConnectionStatus('error');
    }
  }, [connectionStatus]);

  const handlePTTDown = async () => {
    if (connectionStatus !== 'connected') return;
    setPttStatus('transmitting');
    if (appMode === 'human') {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(t => t.enabled = true);
      }
    } else {
      const ctx = inputAudioContextRef.current;
      if (ctx) {
        if (ctx.state === 'suspended') await ctx.resume();
        if (!localStreamRef.current) {
          localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        const source = ctx.createMediaStreamSource(localStreamRef.current);
        scriptProcessorRef.current = ctx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current.onaudioprocess = (e) => {
          const blob = createPCMBlob(e.inputBuffer.getChannelData(0));
          sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: blob }));
        };
        source.connect(scriptProcessorRef.current);
        scriptProcessorRef.current.connect(ctx.destination);
      }
    }
  };

  const handlePTTUp = () => {
    setPttStatus('idle');
    if (appMode === 'human') {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(t => t.enabled = false);
      }
    } else if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-950 p-4 font-sans antialiased select-none">
      <div className="relative w-full max-w-md h-[780px] bg-slate-900 border-4 border-slate-800 rounded-[3rem] shadow-2xl overflow-hidden flex flex-col">
        
        {/* Status Bar */}
        <div className="bg-slate-900 h-8 flex items-center justify-between px-8 text-[10px] text-slate-400 font-medium pt-2">
          <div className="flex items-center gap-2">
            <span className="bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 font-bold tracking-tight">ID: {myPeerId || '....'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Signal size={12} className={connectionStatus === 'connected' ? 'text-emerald-500' : 'text-slate-600'} />
            <Wifi size={12} className={connectionStatus === 'connected' ? 'text-emerald-500' : 'text-slate-600'} />
            <Battery size={12} className="text-slate-500 rotate-90" />
          </div>
        </div>

        {/* Mode Selector */}
        <div className="px-6 pt-4">
          <div className="bg-slate-800/50 p-1 rounded-2xl flex items-center border border-slate-700/50">
            <button 
              onClick={() => { setAppMode('dispatch'); setConnectionStatus('disconnected'); setIsPeerLinked(false); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[11px] font-black transition-all ${appMode === 'dispatch' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Bot size={14} /> DISPATCH
            </button>
            <button 
              onClick={() => { setAppMode('human'); setConnectionStatus('disconnected'); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[11px] font-black transition-all ${appMode === 'human' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Users size={14} /> HUMAN
            </button>
          </div>
        </div>

        {/* Link Input */}
        <div className="px-6 mt-6">
          {appMode === 'human' ? (
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="Target Radio ID"
                value={targetPeerId}
                onChange={(e) => setTargetPeerId(e.target.value.replace(/\D/g, '').slice(0, 4))}
                className="flex-1 bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/50 text-white placeholder-slate-600"
              />
              <button 
                onClick={linkToPeer}
                disabled={isPeerLinked}
                className={`px-4 rounded-xl flex items-center gap-2 text-[11px] font-black transition-all ${isPeerLinked ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
              >
                {isPeerLinked ? <Wifi size={14} /> : <LinkIcon size={14} />}
                {isPeerLinked ? 'LINKED' : 'CONNECT'}
              </button>
            </div>
          ) : (
            <button 
              onClick={connectToGemini}
              disabled={connectionStatus === 'connected'}
              className={`w-full py-2.5 rounded-xl flex items-center justify-center gap-2 text-[11px] font-black transition-all ${connectionStatus === 'connected' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'}`}
            >
              {connectionStatus === 'connecting' ? <RefreshCw size={14} className="animate-spin" /> : <Signal size={14} />}
              {connectionStatus === 'connected' ? 'LINK ESTABLISHED' : 'AUTHORIZE FREQUENCY'}
            </button>
          )}
        </div>

        {/* VU Meter & Status */}
        <div className="mt-8 px-6 flex flex-col items-center">
          <div className={`w-full h-32 rounded-3xl flex flex-col items-center justify-center transition-all duration-300 border-2 ${
            pttStatus === 'transmitting' ? 'bg-red-500/10 border-red-500/40 shadow-[0_0_40px_-10px_rgba(239,68,68,0.3)]' :
            pttStatus === 'receiving' ? 'bg-emerald-500/10 border-emerald-500/40 shadow-[0_0_40px_-10px_rgba(16,185,129,0.3)]' :
            'bg-slate-800/30 border-slate-800'
          }`}>
            <span className={`text-[9px] font-black uppercase tracking-[0.3em] mb-4 ${
              pttStatus === 'transmitting' ? 'text-red-400' :
              pttStatus === 'receiving' ? 'text-emerald-400' : 'text-slate-600'
            }`}>
              {pttStatus === 'transmitting' ? 'Broadcasting TX' : 
               pttStatus === 'receiving' ? 'Receiving RX' : 'Frequency Clear'}
            </span>
            <div className="flex items-end gap-1.5 h-12">
              {[...Array(15)].map((_, i) => (
                <div 
                  key={i} 
                  className={`w-1.5 rounded-full transition-all duration-150 ${
                    pttStatus === 'transmitting' ? 'bg-red-500 animate-pulse' :
                    pttStatus === 'receiving' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'
                  }`}
                  style={{ 
                    height: pttStatus !== 'idle' ? `${20 + Math.random() * 80}%` : '4px',
                    animationDelay: `${i * 0.1}s` 
                  }}
                />
              ))}
            </div>
          </div>
          
          {errorMessage && (
            <div className="mt-4 bg-red-900/20 border border-red-500/30 px-4 py-2 rounded-lg flex items-center gap-2 animate-bounce">
              <ShieldAlert className="text-red-400" size={14} />
              <span className="text-[10px] text-red-200 font-bold uppercase">{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Center UI Spacer */}
        <div className="flex-1" />

        {/* PTT Interface */}
        <div className="p-10 bg-slate-800/30 border-t border-slate-800/50 rounded-t-[3.5rem] flex flex-col items-center gap-8">
          <div className="flex items-center justify-around w-full">
            <button className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center text-slate-500 border border-slate-700/50 active:scale-90 transition-transform">
              <Settings size={20} />
            </button>
            
            <div className="relative group">
              <div className={`absolute -inset-6 rounded-full border border-dashed transition-all duration-500 ${
                pttStatus === 'transmitting' ? 'border-red-500/50 scale-125 rotate-180' : 'border-indigo-500/10 scale-100 rotate-0'
              }`} />
              <button 
                onMouseDown={handlePTTDown}
                onMouseUp={handlePTTUp}
                onMouseLeave={handlePTTUp}
                onTouchStart={(e) => { e.preventDefault(); handlePTTDown(); }}
                onTouchEnd={(e) => { e.preventDefault(); handlePTTUp(); }}
                disabled={connectionStatus !== 'connected'}
                className={`w-36 h-36 rounded-full flex flex-col items-center justify-center transition-all duration-75 active:scale-95 disabled:opacity-20 shadow-2xl relative z-10 ${
                  pttStatus === 'transmitting' ? 
                  'bg-gradient-to-br from-red-500 to-red-700 border-4 border-red-400/50 animate-transmit' :
                  'bg-gradient-to-br from-indigo-500 to-indigo-700 border-4 border-indigo-400/30'
                }`}
              >
                {pttStatus === 'transmitting' ? <Mic size={52} className="text-white drop-shadow-lg" /> : <MicOff size={52} className="text-white/60" />}
                <span className="text-[10px] font-black mt-3 text-white uppercase tracking-[0.2em]">PTT</span>
              </button>
            </div>

            <button className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center text-slate-500 border border-slate-700/50 active:scale-90 transition-transform">
              <History size={20} />
            </button>
          </div>
          
          <div className="flex flex-col items-center gap-2">
            <div className="h-1.5 w-16 bg-slate-700/50 rounded-full" />
            <p className="text-[9px] text-slate-600 font-bold uppercase tracking-[0.4em]">Secure Satellite Protocol</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;