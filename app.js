// ====================== COMPLETE JAVASCRIPT (app.js) ======================
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
    let connected = false;
    let rec = null;
    let audioCtx = null, analyser = null, rafId = null;
    let agentRec = null, sttAbort = null;
    let captionsSource = "none";
    let receivedDataChannelCaption = false;

    // Natural goodbye state
    let isEndingCall = false;
    let waitingForAgentGoodbye = false;
    let goodbyeFallback = null;

    // Helper
    function setYouText(text){
      youLive.textContent = text || "Awaiting input...";
      youLive.classList.toggle("placeholder", !text);
      if (text && connected && !isEndingCall) checkEndIntent(text);
    }

    function setAgentText(text){
      agentLive.textContent = text || "Awaiting response...";
      agentLive.classList.toggle("placeholder", !text);

      if (waitingForAgentGoodbye && text) {
        const t = text.toLowerCase().trim();
        const hasGoodbye = /(bye|goodbye|take care|have a (great|nice|wonderful|good) day|talk later|see you|stay safe|thank you|thanks)/i.test(t);
        const complete = /[.!?]$/.test(text.trim()) || t.split(' ').length >= 6;
        if (hasGoodbye && complete) {
          setTimeout(() => { if (connected) disconnect(); }, 1200);
          waitingForAgentGoodbye = false;
          if (goodbyeFallback) clearTimeout(goodbyeFallback);
        }
      }
    }

    function setAgentSpeaking(on){
      agentSpeakingBadge.textContent = `Agent: ${on ? "Speaking" : "Veta AI"}`;
      agentDot.classList.toggle("active", on);
      if (connected && !isEndingCall) voiceRing.classList.toggle("active", on);
    }

    function setCaptionsBadge(){
      captionsInfoEl.textContent = `Captions: ${captionsSource}`;
      captionsDot.classList.toggle("active", captionsSource !== "none");
    }

    function checkEndIntent(text){
      const lower = text.toLowerCase();
      const phrases = ['bye','goodbye','good bye','bye bye','end call','disconnect','hang up','gotta go','have to go','talk later','thanks bye','thank you','take care','see you','not interested','no thanks'];
      if (phrases.some(p => lower.includes(p))) startGracefulEnd();
    }

    function startGracefulEnd(){
      if (isEndingCall) return;
      isEndingCall = true;
      waitingForAgentGoodbye = true;

      voiceRing.classList.remove('active','connected');
      voiceRing.classList.add('ending');

      goodbyeFallback = setTimeout(() => { if (connected) disconnect(); }, 7000);
    }

    function animateEQ(){
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteFrequencyData(data);
        let energy = 0;
        eqBars.forEach((bar,i) => {
          const v = data[i*4] / 255;
          bar.style.height = `${Math.max(8, 8 + v*36)}px`;
          energy += v;
        });
        const speaking = energy/eqBars.length > 0.12;
        setAgentSpeaking(speaking);
        rafId = requestAnimationFrame(loop);
      };
      loop();
    }

    // User STT
    function startUserSTT(){
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return setYouText("Speech recognition not supported");
      rec = new SR();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = e => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          transcript = e.results[i][0].transcript.trim();
        }
        setYouText(transcript);
      };
      rec.onend = () => { if (connected && !isEndingCall) rec.start(); };
      rec.start();
    }

    function stopUserSTT(){ rec && rec.stop(); rec = null; }

    // DataChannel captions
    function setupDataChannel(pc){
      pc.ondatachannel = e => {
        const ch = e.channel;
        ch.onmessage = m => {
          try {
            const data = typeof m.data === "string" ? m.data : JSON.parse(m.data);
            const text = data.text || data.caption || data.message || "";
            if (text) {
              receivedDataChannelCaption = true;
              captionsSource = "datachannel";
              setCaptionsBadge();
              setAgentText(text);
            }
          } catch { if (typeof m.data === "string") setAgentText(m.data); }
        };
      };
      pc.createDataChannel("client");
    }

    // Fallback agent STT
    function startAgentSTT(stream){
      if (!MediaRecorder || !MediaRecorder.isTypeSupported("audio/webm")) return;
      try {
        agentRec = new MediaRecorder(stream, {mimeType:"audio/webm"});
      } catch { return; }
      sttAbort = new AbortController();
      agentRec.ondataavailable = async e => {
        if (receivedDataChannelCaption || !e.data.size) return;
        const form = new FormData();
        form.append("file", e.data, "audio.webm");
        try {
          const res = await fetch("https://webcall.vetaai.com/v1/stt/agent", {method:"POST", body:form, signal:sttAbort.signal});
          if (res.ok) {
            const json = await res.json();
            if (json.text) {
              captionsSource = "stt";
              setCaptionsBadge();
              setAgentText(json.text);
            }
          }
        } catch{}
      };
      agentRec.start(800);
    }

    function stopAgentSTT(){
      agentRec && agentRec.stop();
      sttAbort && sttAbort.abort();
    }

    // Connect
    async function connect(){
      if (connected) return;
      voiceRing.classList.add('connecting');
      rtcInfoEl.textContent = "Connecting...";

      try {
        const resp = await fetch("https://webcall.vetaai.com/v1/voice/session", {method:"POST", headers:{"Content-Type":"application/json"}, body:"{}"});
        const data = await resp.json();
        const token = data.client_secret?.value || data.client_secret || data.token;
        const url = data.rtc_url || data.url || data.webrtc_url || data.web_rtc_url;

        pc = new RTCPeerConnection();
        setupDataChannel(pc);

        const audio = new Audio();
        audio.autoplay = true;
        pc.ontrack = e => {
          audio.srcObject = e.streams[0];
          audioCtx = new (AudioContext || webkitAudioContext)();
          const source = audioCtx.createMediaStreamSource(e.streams[0]);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          animateEQ();
          startAgentSTT(e.streams[0]);
        };

        localStream = await navigator.mediaDevices.getUserMedia({audio:true});
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

        const offer = await pc.createOffer({offerToReceiveAudio:true});
        await pc.setLocalDescription(offer);

        const sdpRes = await fetch(url, {method:"POST", headers:{ "Content-Type":"application/sdp", Authorization:`Bearer ${token}` }, body:offer.sdp});
        const answer = await sdpRes.text();
        await pc.setRemoteDescription({type:"answer", sdp:answer});

        voiceRing.classList.remove('connecting');
        voiceRing.classList.add('connected');
        connected = true;
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        muteBtn.disabled = false;
        unmuteBtn.disabled = true;
        rtcInfoEl.textContent = "Connected";
        rtcDot.classList.add("active");
        startUserSTT();

      } catch (err) {
        voiceRing.classList.remove('connecting');
        rtcInfoEl.textContent = "Error: "+err.message;
      }
    }

    // Disconnect
    async function disconnect(){
      if (!connected) return;

      voiceRing.classList.remove('connected','active','connecting','ending');
      pc && pc.close();
      pc = null;
      localStream && localStream.getTracks().forEach(t=>t.stop());
      localStream = null;
      if (rafId) cancelAnimationFrame(rafId);
      audioCtx && audioCtx.close();
      stopUserSTT();
      stopAgentSTT();
      if (goodbyeFallback) clearTimeout(goodbyeFallback);

      connected = false;
      isEndingCall = false;
      waitingForAgentGoodbye = false;

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

    function mute(){ localStream.getAudioTracks().forEach(t=>t.enabled=false); muteBtn.disabled=true; unmuteBtn.disabled=false; }
    function unmute(){ localStream.getAudioTracks().forEach(t=>t.enabled=true); muteBtn.disabled=false; unmuteBtn.disabled=true; }

    // Buttons
    connectBtn.onclick = connect;
    disconnectBtn.onclick = disconnect;
    muteBtn.onclick = mute;
    unmuteBtn.onclick = unmute;

