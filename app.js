// Voice Assistant Client
const rtcInfoEl = document.getElementById("rtcInfo");
const rtcDot = document.getElementById("rtcDot");
const captionsInfoEl = document.getElementById("captionsInfo");
const captionsDot = document.getElementById("captionsDot");
const agentDot = document.getElementById("agentDot");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const muteBtn = document.getElementById("muteBtn");
const unmuteBtn = document.getElementById("unmuteBtn");
const youLive = document.getElementById("youLive");
const agentLive = document.getElementById("agentLive");
const agentSpeakingBadge = document.getElementById("agentSpeakingBadge");
const voiceRing = document.getElementById("voiceRing");
const eqBars = document.querySelectorAll(".bar");

// State
let pc = null;
let localStream = null;
let remoteAudio = null;
let connected = false;
let rec = null;
let audioCtx = null, analyser = null, remoteSource = null, rafId = null;
let agentRec = null, sttAbort = null;
let captionsSource = "none";
let receivedDataChannelCaption = false;

// Helper functions
function setYouText(text){
  youLive.textContent = text || "Awaiting input...";
  youLive.classList.toggle("placeholder", !text);
}

function setAgentText(text){
  agentLive.textContent = text || "Awaiting response...";
  agentLive.classList.toggle("placeholder", !text);
}

function setAgentSpeaking(on){
  agentSpeakingBadge.textContent = `Agent: ${on ? "Speaking" : "Idle"}`;
  agentDot.classList.toggle("active", on);
  voiceRing.classList.toggle("active", on);
}

function setCaptionsBadge(){
  captionsInfoEl.textContent = `Captions: ${captionsSource}`;
  captionsDot.classList.toggle("active", captionsSource !== "none");
}

// Audio visualization
function animateFromAnalyser(){
  if (!analyser) return;
  const arr = new Uint8Array(analyser.frequencyBinCount);
  const loop = () => {
    analyser.getByteFrequencyData(arr);
    const take = Math.min(eqBars.length, 16);
    let energy = 0;
    for (let i=0; i<take; i++){
      const v = arr[i] / 255;
      const h = Math.max(8, Math.round(8 + v * 32));
      eqBars[i].style.height = `${h}px`;
      energy += v;
    }
    const avg = energy / take;
    setAgentSpeaking(avg > 0.12);
    rafId = requestAnimationFrame(loop);
  };
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

// User STT (Speech Recognition)
function startUserSTT(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { 
    setYouText("Speech recognition not supported"); 
    return; 
  }
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  
  rec.onresult = (e) => {
    let text = "";
    for (let i = e.resultIndex; i < e.results.length; i++){
      text = e.results[i][0].transcript.trim();
      setYouText(text);
    }
  };
  
  rec.onerror = () => {};
  rec.onend = () => { 
    if (connected) rec.start(); 
  };
  rec.start();
}

function stopUserSTT(){ 
  try { 
    rec && rec.stop(); 
  } catch {} 
  rec = null; 
}

// Data Channel for captions
function setupDataChannel(pc){
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    ch.onmessage = (m) => {
      let text = "";
      try {
        const msg = JSON.parse(m.data);
        text = msg.text || msg.caption || msg.message || "";
      } catch {
        if (typeof m.data === "string") text = m.data;
      }
      if (text){
        receivedDataChannelCaption = true;
        captionsSource = "datachannel"; 
        setCaptionsBadge();
        setAgentText(text);
      }
    };
  };
  pc.createDataChannel("client");
}

// Agent STT Fallback
function startAgentSTT(remoteStream, { lang="en", sliceMs=800 } = {}){
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported("audio/webm")){
    if (captionsSource === "none"){ 
      captionsSource = "unavailable"; 
      setCaptionsBadge(); 
    }
    return;
  }
  
  try {
    agentRec = new MediaRecorder(remoteStream, { mimeType:"audio/webm" });
  } catch(e) {
    if (captionsSource === "none"){ 
      captionsSource = "unavailable"; 
      setCaptionsBadge(); 
    }
    return;
  }
  
  sttAbort = new AbortController();
  agentRec.addEventListener("dataavailable", async (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    if (receivedDataChannelCaption) return;
    
    const form = new FormData();
    form.append("file", ev.data, `agent-${Date.now()}.webm`);
    form.append("lang", lang);
    
    try {
      const res = await fetch("/v1/stt/agent", { 
        method:"POST", 
        body:form, 
        signal: sttAbort.signal 
      });
      if (!res.ok) return;
      const json = await res.json();
      if (json && typeof json.text === "string"){
        if (captionsSource === "none"){ 
          captionsSource = "stt"; 
          setCaptionsBadge(); 
        }
        if (!receivedDataChannelCaption){
          setAgentText(json.text || " ");
        }
      }
    } catch(_) {}
  });
  
  agentRec.start(sliceMs);
  if (captionsSource === "none"){ 
    captionsSource = "stt"; 
    setCaptionsBadge(); 
  }
}

function stopAgentSTT(){
  try { agentRec && agentRec.stop(); } catch {}
  agentRec = null;
  try { sttAbort && sttAbort.abort(); } catch {}
  sttAbort = null;
}

// Connect to voice session
async function connect(){
  if (connected) return;
  
  rtcInfoEl.textContent = "Starting...";
  captionsSource = "none"; 
  receivedDataChannelCaption = false; 
  setCaptionsBadge();
  setAgentText(""); 
  setYouText("");

  // Get session token from backend
  let data;
  try {
    const resp = await fetch("/v1/voice/session", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({})
    });
    if (!resp.ok) throw new Error(await resp.text());
    data = await resp.json();
  } catch(err) {
    rtcInfoEl.textContent = "Error: " + err.message;
    return;
  }

  const clientSecret = data.client_secret?.value || data.client_secret || data.token;
  const rtcUrl = data.rtc_url || data.url || data.web_rtc_url || data.webrtc_url;
  
  if (!clientSecret || !rtcUrl){
    rtcInfoEl.textContent = "Missing config";
    return;
  }

  // Setup WebRTC
  pc = new RTCPeerConnection();
  setupDataChannel(pc);
  remoteAudio = new Audio();
  remoteAudio.autoplay = true;

  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
    
    // Audio analyzer for visualization
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      remoteSource = audioCtx.createMediaStreamSource(e.streams[0]);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      remoteSource.connect(analyser);
      animateFromAnalyser();
    } catch(err) { 
      console.warn("AudioContext:", err); 
    }
    
    startAgentSTT(e.streams[0], { lang:"en", sliceMs:800 });
  };

  // Get microphone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  } catch(err) {
    rtcInfoEl.textContent = "Mic error: " + err.message;
    return;
  }
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Create offer
  const offer = await pc.createOffer({ 
    offerToReceiveAudio:true, 
    offerToReceiveVideo:false 
  });
  await pc.setLocalDescription(offer);

  // SDP exchange
  try {
    const sdpResp = await fetch(rtcUrl, {
      method: "POST",
      headers: { 
        "Content-Type":"application/sdp", 
        "Authorization": `Bearer ${clientSecret}` 
      },
      body: offer.sdp
    });
    if (!sdpResp.ok) throw new Error(await sdpResp.text());
    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type:"answer", sdp: answerSdp });
  } catch(err) {
    rtcInfoEl.textContent = "SDP error: " + err.message;
    return;
  }

  // Update UI
  connected = true;
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  muteBtn.disabled = false;
  unmuteBtn.disabled = true;
  rtcInfoEl.textContent = "Connected";
  rtcDot.classList.add("active");
  
  startUserSTT();
  
  setTimeout(() => { 
    if (receivedDataChannelCaption) { 
      captionsSource = "datachannel"; 
      setCaptionsBadge(); 
    }
  }, 2000);
}

// Disconnect
async function disconnect(){
  if (!connected) return;

  try { pc && pc.close(); } catch {}
  pc = null;

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  
  try { audioCtx && audioCtx.close(); } catch {}
  audioCtx = null; 
  analyser = null; 
  remoteSource = null;
  setAgentSpeaking(false);

  stopUserSTT();
  stopAgentSTT();

  connected = false;
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  muteBtn.disabled = true;
  unmuteBtn.disabled = true;
  rtcInfoEl.textContent = "Disconnected";
  rtcDot.classList.remove("active");
  
  setYouText("");
  setAgentText("");
  captionsSource = "none"; 
  setCaptionsBadge();
}

// Mute controls
function mute(){
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = false);
  muteBtn.disabled = true; 
  unmuteBtn.disabled = false;
}

function unmute(){
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = true);
  muteBtn.disabled = false; 
  unmuteBtn.disabled = true;
}

// Event listeners
connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
muteBtn.addEventListener("click", mute);
unmuteBtn.addEventListener("click", unmute);