
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Radio, Settings, History, Signal, Wifi, Battery, User, ShieldAlert, Users, Bot, Link as LinkIcon, RefreshCw } from 'lucide-react';
import { Peer, MediaConnection } from 'peerjs';
import { ConnectionStatus, PTTStatus, ChatMessage, AppMode } from './types';
import { decodeBase64, decodeAudioData, createPCMBlob } from './utils/audioUtils';

const SYSTEM_INSTRUCTION = `You are a professional radio dispatcher on a secure PoC network. 
- Be brief. Use radio protocols like "Roger", "Copy", "Over".
- Your callsign is "BASE-1". The user is "UNIT-7".`;

const App: React.FC = () => {
  // Mode & UI States
  const [appMode, setAppMode] = useState<AppMode>('dispatch');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [pttStatus, setPttStatus] = useState<PTTStatus>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Peer-to-Peer States
  const [myPeerId, setMyPeerId] = useState<string>('');
  const [targetPeerId, setTargetPeerId] = useState<string>('');
  const [isPeerLinked, setIsPeerLinked] = useState(false);

  // Refs
  const peerRef = useRef<Peer | null>(null);
  const currentCallRef = useRef<MediaConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioRef = useRef<HTMLAudioElement>(new Audio());

  const currentInputText = useRef('');
  const currentOutputText = useRef('');

  // --- PEER INITIALIZATION ---
  useEffect(() => {
    // Generate a simple 4-digit ID for easier radio usage
    const randomId = Math.floor(1000 + Math.random() * 9000).toString();
    const peer = new Peer(`POC-${randomId}`);
    
    peer.on('open', (id) => {
      setMyPeerId(id.replace('POC-', ''));
      console.log('Peer ID:', id);
    });

    peer.on('call', (call) => {
      // Auto-answer incoming radio signals
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        localStreamRef.current = stream;
        // Keep local stream muted until PTT is pressed
        stream.getAudioTracks().forEach(t => t.enabled = false);
        
        call.answer(stream);
        setupCall(call);
        setIsPeerLinked(true);
        setAppMode('human');
        setConnectionStatus('connected');
      });
    });

    peer.on('error', (err) => {
      setErrorMessage(`Network error: ${err.type}`);
    });

    peerRef.current = peer;
    return () => peer.destroy();
  }, []);

  const setupCall = (call: MediaConnection) => {
    currentCallRef.current = call;
    call.on('stream', (remoteStream) => {
      remoteStreamRef.current = remoteStream;
      audioRef.current.srcObject = remoteStream;
      audioRef.current.play().catch(e => console.error("Audio play failed", e));
      
      // Monitor remote stream to show "Receiving" status
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(remoteStream);
      const analyser = audioContext.createAnalyser();
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      const checkVolume = () => {
        analyser.getByteFrequencyData(dataArray);
        const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
        if (volume > 5 && pttStatus !== 'transmitting') {
          setPttStatus('receiving');
        } else if (pttStatus === 'receiving') {
          setPttStatus('idle');
        }
        if (currentCallRef.current) requestAnimationFrame(checkVolume);
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
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach(t => t.enabled = false);
      
      const call = peerRef.current.call(`POC-${targetPeerId}`, stream);
      if (call) {
        setupCall(call);
        setIsPeerLinked(true);
        setConnectionStatus('connected');
      }
    } catch (err) {
      setErrorMessage("Microphone required for Link.");
      setConnectionStatus('error');
    }
  };

  // --- GEMINI DISPATCH LOGIC ---
  const connectToGemini = useCallback(async () => {
    if (connectionStatus === 'connecting' || connectionStatus === 'connected') return;
    setConnectionStatus('connecting');
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => setConnectionStatus('connected'),
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              setPttStatus('receiving');
              const ctx = outputAudioContextRef.current;
              const buffer = await decodeAudioData(decodeBase64(audioData), ctx, 24000, 1);
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
          onerror: (e) => setErrorMessage(`AI Error: ${JSON.stringify(e)}`)
        }
      });
      sessionPromiseRef.current = sessionPromise;
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setErrorMessage("AI Connection Failed.");
    }
  }, [connectionStatus]);

  // --- PTT CONTROL ---
  const startTransmitting = async () => {
    if (connectionStatus !== 'connected') return;
    setPttStatus('transmitting');

    if (appMode === 'human') {
      // Unmute WebRTC track
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(t => t.enabled = true);
      }
    } else {
      // Send to Gemini
      if (!localStreamRef.current) {
        localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const ctx = inputAudioContextRef.current;
      if (ctx) {
        if (ctx.state === 'suspended') await ctx.resume();
        const source = ctx.createMediaStreamSource(localStreamRef.current);
        scriptProcessorRef.current = ctx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current.onaudioprocess = (e) => {
          const pcm = createPCMBlob(e.inputBuffer.getChannelData(0));
          sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: { data: pcm, mimeType: 'audio/pcm;rate=16000' }}));
        };
        source.connect(scriptProcessorRef.current);
        scriptProcessorRef.current.connect(ctx.destination);
      }
    }
  };

  const stopTransmitting = () => {
    setPttStatus('idle');
    if (appMode === 'human') {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(t => t.enabled = false);
      }
    } else {
      if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
      }
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-950 p-4 font-sans antialiased">
      <div className="relative w-full max-w-md h-[800px] bg-slate-900 border-4 border-slate-800 rounded-[3rem] shadow-2xl overflow-hidden flex flex-col">
        
        {/* Status Bar */}
        <div className="bg-slate-900 h-8 flex items-center justify-between px-8 text-[10px] text-slate-400 font-medium pt-2">
          <div className="flex items-center gap-2">
            <span className="bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30">ID: {myPeerId || '....'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Signal size={12} className={connectionStatus === 'connected' ? 'text-emerald-500' : 'text-slate-600'} />
            <Wifi size={12} className={connectionStatus === 'connected' ? 'text-emerald-500' : 'text-slate-600'} />
            <Battery size={12} className="text-slate-500 rotate-90" />
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="px-6 pt-4">
          <div className="bg-slate-800/50 p-1 rounded-xl flex items-center border border-slate-700">
            <button 
              onClick={() => { setAppMode('dispatch'); setConnectionStatus('disconnected'); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${appMode === 'dispatch' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Bot size={16} /> DISPATCH
            </button>
            <button 
              onClick={() => { setAppMode('human'); setConnectionStatus('disconnected'); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${appMode === 'human' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Users size={16} /> HUMAN
            </button>
          </div>
        </div>

        {/* Connection Control */}
        <div className="px-6 mt-4">
          {appMode === 'human' ? (
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input 
                  type="text" 
                  placeholder="Enter Radio ID..."
                  value={targetPeerId}
                  onChange={(e) => setTargetPeerId(e.target.value.toUpperCase())}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-indigo-500 text-white"
                />
              </div>
              <button 
                onClick={linkToPeer}
                disabled={isPeerLinked}
                className={`px-4 rounded-xl flex items-center gap-2 text-xs font-bold transition-all ${isPeerLinked ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md'}`}
              >
                {isPeerLinked ? <Wifi size={14} /> : <LinkIcon size={14} />}
                {isPeerLinked ? 'LINKED' : 'LINK'}
              </button>
            </div>
          ) : (
            <button 
              onClick={connectToGemini}
              disabled={connectionStatus === 'connected'}
              className={`w-full py-2.5 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-all ${connectionStatus === 'connected' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'}`}
            >
              {connectionStatus === 'connected' ? <RefreshCw size={14} className="animate-spin" /> : <Bot size={14} />}
              {connectionStatus === 'connected' ? 'DISPATCH ONLINE' : 'WAKE DISPATCH'}
            </button>
          )}
        </div>

        {/* Visualizer Panel */}
        <div className="mt-4 px-6">
          <div className={`h-28 rounded-2xl flex flex-col items-center justify-center transition-all duration-300 border-2 ${
            pttStatus === 'transmitting' ? 'bg-red-500/10 border-red-500/50 shadow-[0_0_20px_rgba(239,68,68,0.2)]' :
            pttStatus === 'receiving' ? 'bg-emerald-500/10 border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.2)]' :
            'bg-slate-800/50 border-transparent'
          }`}>
            <span className={`text-[10px] font-black uppercase tracking-[0.2em] mb-1 ${
              pttStatus === 'transmitting' ? 'text-red-400' :
              pttStatus === 'receiving' ? 'text-emerald-400' : 'text-slate-500'
            }`}>
              {pttStatus === 'transmitting' ? 'TX TRANSMITTING' : 
               pttStatus === 'receiving' ? 'RX RECEIVING' : 'CHANNEL IDLE'}
            </span>
            <div className="flex items-center gap-1.5 h-10">
              {[...Array(12)].map((_, i) => (
                <div 
                  key={i} 
                  className={`w-1 rounded-full transition-all duration-150 ${
                    pttStatus === 'transmitting' ? 'bg-red-500 animate-[bounce_0.6s_infinite]' :
                    pttStatus === 'receiving' ? 'bg-emerald-500 animate-[bounce_0.8s_infinite]' : 'bg-slate-700 h-1'
                  }`}
                  style={{ animationDelay: `${i * 0.05}s` }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Message / Info Area */}
        <div className="flex-1 overflow-y-auto px-6 py-4 custom-scrollbar">
          {errorMessage && (
            <div className="bg-red-900/20 border border-red-500/30 p-3 rounded-xl flex items-center gap-3 mb-4 animate-pulse">
              <ShieldAlert className="text-red-400 shrink-0" size={18} />
              <p className="text-[11px] text-red-200">{errorMessage}</p>
            </div>
          )}

          <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-60">
            <div className="w-12 h-12 bg-slate-800/50 rounded-full flex items-center justify-center text-slate-500 border border-slate-700">
              {appMode === 'human' ? <Users size={24} /> : <Bot size={24} />}
            </div>
            <div>
              <p className="text-slate-300 font-bold text-sm tracking-tight">
                {appMode === 'human' ? (isPeerLinked ? `Linked to ${targetPeerId}` : 'Enter ID to start Radio Link') : 'Dispatcher Base is ready'}
              </p>
              <p className="text-slate-500 text-[11px] mt-1 max-w-[200px] mx-auto">
                Maintain strict radio discipline. Only one unit can transmit at a time.
              </p>
            </div>
          </div>
        </div>

        {/* Bottom PoC UI */}
        <div className="p-8 bg-slate-800/40 border-t border-slate-800/50 rounded-t-[3rem] space-y-6">
          <div className="flex items-center justify-around px-2">
            <button className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-all border border-slate-700 shadow-inner">
              <Settings size={20} />
            </button>
            
            {/* GIANT PTT BUTTON */}
            <div className="relative group">
              <div className={`absolute -inset-4 rounded-full border-2 border-dashed transition-all duration-700 opacity-50 ${
                pttStatus === 'transmitting' ? 'border-red-500 scale-110 animate-spin' : 'border-indigo-500/20'
              }`} />
              <button 
                onMouseDown={startTransmitting}
                onMouseUp={stopTransmitting}
                onMouseLeave={stopTransmitting}
                onTouchStart={(e) => { e.preventDefault(); startTransmitting(); }}
                onTouchEnd={(e) => { e.preventDefault(); stopTransmitting(); }}
                disabled={connectionStatus !== 'connected'}
                className={`w-32 h-32 rounded-full shadow-2xl flex flex-col items-center justify-center transition-all duration-75 active:scale-95 disabled:opacity-30 disabled:grayscale ${
                  pttStatus === 'transmitting' ? 
                  'bg-gradient-to-br from-red-500 to-red-700 border-4 border-red-400/50 shadow-red-500/50' :
                  'bg-gradient-to-br from-indigo-500 to-indigo-700 border-4 border-indigo-400/50 shadow-indigo-500/40'
                }`}
              >
                {pttStatus === 'transmitting' ? <Mic size={48} className="text-white drop-shadow-md" /> : <MicOff size={48} className="text-white/70" />}
                <span className="text-[11px] font-black mt-2 text-white uppercase tracking-widest drop-shadow-sm">PUSH TALK</span>
              </button>
            </div>

            <button className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-all border border-slate-700 shadow-inner">
              <History size={20} />
            </button>
          </div>
          
          <div className="flex flex-col items-center gap-1">
            <div className="h-1 w-12 bg-slate-700 rounded-full" />
            <p className="text-[9px] text-slate-600 font-bold uppercase tracking-[0.4em] pt-2">
              Secure PoC Network • 256-bit AES
            </p>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(71, 85, 105, 0.4); border-radius: 10px; }
        @keyframes bounce { 
          0%, 100% { height: 4px; opacity: 0.5; } 
          50% { height: 40px; opacity: 1; } 
        }
      `}</style>
    </div>
  );
};

export default App;
