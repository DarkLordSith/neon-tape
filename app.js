(() => {
  /* ================= Конфигурация ================= */

  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;

  const SHIFT_DURATION_MS = 8 * HOUR_MS;      // длительность смены
  const FOCUS_BLOCK_MS = 50 * MINUTE_MS;      // блок фокуса до перерыва
  const LONG_PAUSE_MS = 5 * MINUTE_MS;        // пауза такой длины засчитывается как перерыв
  const SNOOZE_MS = 10 * MINUTE_MS;           // на сколько откладывается напоминание о перерыве

  const SHORT_BREAK_MS = 10 * MINUTE_MS;
  const LONG_BREAK_MS = 20 * MINUTE_MS;
  const LONG_BREAK_EVERY = 4;                 // каждый 4-й перерыв — длинный

  const STORAGE_KEY = 'neon-tape-v1';
  const STEPS_PER_BAR = 16;

  const CHORD_INTERVALS = {
    maj7: [0, 4, 7, 11, 14],
    min7: [0, 3, 7, 10, 14],
    dom7: [0, 4, 7, 10, 14],
  };
  const SCALE_INTERVALS = {
    maj: [0, 2, 4, 7, 9],
    min: [0, 3, 5, 7, 10],
  };

  // Степень аккорда (в полутонах от тоники) и его качество для каждого такта прогрессии.
  const RAW_TRACKS = [
    {
      name: 'NEON RAIN',
      bpm: 72,
      rootNote: 50,
      keyLabel: 'D MAJ',
      scaleMode: 'maj',
      swingAmount: .18,
      chordProgression: [[0, 'maj7'], [9, 'min7'], [2, 'min7'], [7, 'dom7']],
      kickSteps: [0, 7, 10],
      bassSteps: [0, 7, 10],
      leadDensity: .16,
    },
    {
      name: 'CHROME DISTRICT',
      bpm: 80,
      rootNote: 57,
      keyLabel: 'A MIN',
      scaleMode: 'min',
      swingAmount: .12,
      chordProgression: [[0, 'min7'], [5, 'min7'], [8, 'maj7'], [7, 'dom7']],
      kickSteps: [0, 6, 10],
      bassSteps: [0, 6, 10, 14],
      leadDensity: .12,
    },
    {
      name: 'NIGHT MARKET',
      bpm: 68,
      rootNote: 53,
      keyLabel: 'F MAJ',
      scaleMode: 'maj',
      swingAmount: .22,
      chordProgression: [[0, 'maj7'], [2, 'min7'], [4, 'min7'], [5, 'maj7']],
      kickSteps: [0, 10],
      bassSteps: [0, 10],
      leadDensity: .2,
    },
    {
      name: 'SYNTH SPRAWL',
      bpm: 76,
      rootNote: 52,
      keyLabel: 'E MIN',
      scaleMode: 'min',
      swingAmount: .15,
      chordProgression: [[0, 'min7'], [3, 'maj7'], [10, 'dom7'], [5, 'min7']],
      kickSteps: [0, 3, 8, 11],
      bassSteps: [0, 3, 8, 11],
      leadDensity: .14,
    },
    {
      name: 'LOW BATTERY',
      bpm: 70,
      rootNote: 48,
      keyLabel: 'C MAJ',
      scaleMode: 'maj',
      swingAmount: .2,
      chordProgression: [[5, 'maj7'], [4, 'min7'], [2, 'min7'], [0, 'maj7']],
      kickSteps: [0, 7, 9],
      bassSteps: [0, 7, 9],
      leadDensity: .18,
    },
    {
      name: 'AFTER HOURS',
      bpm: 74,
      rootNote: 55,
      keyLabel: 'G MIN',
      scaleMode: 'min',
      swingAmount: .16,
      chordProgression: [[0, 'min7'], [8, 'maj7'], [3, 'maj7'], [7, 'min7']],
      kickSteps: [0, 10, 13],
      bassSteps: [0, 10, 13],
      leadDensity: .15,
    },
  ];

  // Дополняем трек расчётными полями: длина такта, количество тактов/шагов, длительность в секундах.
  function withDerivedTiming(track) {
    const barDurationSeconds = 240 / track.bpm;
    const barCount = Math.max(32, Math.round(200 / barDurationSeconds / 4) * 4);
    return {
      ...track,
      barCount,
      stepCount: barCount * STEPS_PER_BAR,
      lengthSeconds: barCount * barDurationSeconds,
    };
  }

  const TRACKS = RAW_TRACKS.map(withDerivedTiming);

  /* ================= Состояние смены ================= */

  const getTodayDateString = () => new Date().toISOString().slice(0, 10);

  function createFreshState() {
    return {
      day: getTodayDateString(),
      playedMs: 0,
      focusStreakMs: 0,
      pauseCount: 0,
      pauseMs: 0,
      breakCount: 0,
      shortPauseStreak: 0,
      trackIndex: 0,
      step: 0,
      snoozeUntil: 0,
    };
  }

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      // Проверяем не только день, но и форму объекта — старые сохранения (до переименования
      // полей) иначе проходят day-проверку и роняют всё дальше на `undefined.bpm` и NaN в LCD.
      if (stored && stored.day === getTodayDateString() && typeof stored.trackIndex === 'number') {
        return stored;
      }
    } catch {}
    return createFreshState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  let state = loadState();

  // stopped | playing | paused | break | ready | done
  let playbackMode = 'stopped';

  let pauseStartedAt = 0;
  let breakStartedAt = 0;
  let breakEndsAt = 0;
  let activeAlertKind = '';

  /* ================= Аудиодвижок ================= */

  let audioCtx, masterGain, musicBus, tapeToneFilter, levelAnalyser, echoDelay, wowFlutterGain, noiseBuffer, tapeHiss;
  let nextStepTime = 0;

  const midiToFrequency = midiNote => 440 * Math.pow(2, (midiNote - 69) / 12);

  function initAudioEngine() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = getVolumeLevel();

    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    masterGain.connect(compressor).connect(audioCtx.destination);

    // Шина музыки: глушится fadeMusicBus() на паузе и включается при игре.
    musicBus = audioCtx.createGain();
    musicBus.gain.value = 0;

    // Фильтр нижних частот даёт общую «плёночную» тусклость звука.
    tapeToneFilter = audioCtx.createBiquadFilter();
    tapeToneFilter.type = 'lowpass';
    tapeToneFilter.frequency.value = 3800;
    musicBus.connect(tapeToneFilter).connect(masterGain);

    levelAnalyser = audioCtx.createAnalyser();
    levelAnalyser.fftSize = 512;
    tapeToneFilter.connect(levelAnalyser);

    // Короткий фидбэк-дилей для партии лида.
    echoDelay = audioCtx.createDelay(1.5);
    echoDelay.delayTime.value = 0.42;
    const echoFeedback = audioCtx.createGain();
    echoFeedback.gain.value = .33;
    const echoFilter = audioCtx.createBiquadFilter();
    echoFilter.type = 'lowpass';
    echoFilter.frequency.value = 1800;
    echoDelay.connect(echoFilter).connect(echoFeedback).connect(echoDelay);
    echoFilter.connect(musicBus);

    // Медленный LFO даёт эффект «плывущей» высоты тона (wow & flutter) всем голосам, что к нему подключены.
    const wowFlutterLfo = audioCtx.createOscillator();
    wowFlutterLfo.frequency.value = .35;
    wowFlutterGain = audioCtx.createGain();
    wowFlutterGain.gain.value = 7;
    wowFlutterLfo.connect(wowFlutterGain);
    wowFlutterLfo.start();

    noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

    // Постоянный шум плёнки под всем остальным звуком.
    tapeHiss = audioCtx.createBufferSource();
    tapeHiss.buffer = noiseBuffer;
    tapeHiss.loop = true;
    const hissFilter = audioCtx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 4000;
    const hissGain = audioCtx.createGain();
    hissGain.gain.value = .012;
    tapeHiss.connect(hissFilter).connect(hissGain).connect(musicBus);
    tapeHiss.start();
  }

  // Экспоненциальная атака-затухание громкости: 0 → peakLevel → ~0.
  function rampEnvelope(gain, startTime, peakLevel, attackTime, decayTime) {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakLevel, startTime + attackTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + attackTime + decayTime);
  }

  function playChord(startTime, midiNotes, duration) {
    const chordFilter = audioCtx.createBiquadFilter();
    chordFilter.type = 'lowpass';
    chordFilter.frequency.value = 1500;
    chordFilter.connect(musicBus);

    midiNotes.forEach(note => {
      ['sine', 'triangle'].forEach((waveType, voiceIndex) => {
        const isHarmonyVoice = voiceIndex === 1;
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        oscillator.type = waveType;
        oscillator.frequency.value = midiToFrequency(note);
        oscillator.detune.value = isHarmonyVoice ? 6 : -4;
        wowFlutterGain.connect(oscillator.detune);

        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(isHarmonyVoice ? .018 : .045, startTime + .04);
        gain.gain.exponentialRampToValueAtTime(isHarmonyVoice ? .006 : .018, startTime + duration * .7);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration + .4);

        oscillator.connect(gain).connect(chordFilter);
        oscillator.start(startTime);
        oscillator.stop(startTime + duration + .5);
      });
    });
  }

  function playBassNote(startTime, midiNote, duration) {
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    oscillator.type = 'sine';
    oscillator.frequency.value = midiToFrequency(midiNote);
    filter.type = 'lowpass';
    filter.frequency.value = 400;

    rampEnvelope(gain, startTime, .2, .02, duration);
    oscillator.connect(filter).connect(gain).connect(musicBus);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + .1);
  }

  function playKick(startTime) {
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.frequency.setValueAtTime(110, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(42, startTime + .14);

    rampEnvelope(gain, startTime, .45, .005, .3);
    oscillator.connect(gain).connect(musicBus);
    oscillator.start(startTime);
    oscillator.stop(startTime + .4);
  }

  function playNoiseHit(startTime, filterType, frequency, peakLevel, decayTime, q = 1) {
    const source = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    source.buffer = noiseBuffer;
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;

    rampEnvelope(gain, startTime, peakLevel, .003, decayTime);
    source.connect(filter).connect(gain).connect(musicBus);
    source.start(startTime, Math.random() * 1.5);
    source.stop(startTime + decayTime + .05);
  }

  function playLeadNote(startTime, midiNote) {
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = midiToFrequency(midiNote);
    wowFlutterGain.connect(oscillator.detune);

    rampEnvelope(gain, startTime, .05, .02, .7);
    oscillator.connect(gain);
    gain.connect(musicBus);
    gain.connect(echoDelay);
    oscillator.start(startTime);
    oscillator.stop(startTime + .8);
  }

  function playChime() {
    if (!audioCtx) return;
    const startTime = audioCtx.currentTime + .05;

    [880, 1318.5, 1760].forEach((frequency, index) => {
      const delayOffset = index * .22;
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      rampEnvelope(gain, startTime + delayOffset, .12, .01, 1.1);
      oscillator.connect(gain).connect(masterGain);
      oscillator.start(startTime + delayOffset);
      oscillator.stop(startTime + delayOffset + 1.2);
    });
  }

  const INTRO_BARS = 4;             // первые такты — без барабанов, только гармония
  const OUTRO_BARS = 2;             // барабаны стихают перед концом трека
  const MELODY_START_BAR = 8;       // с какого такта может появляться лид-партия
  const RANDOM_HI_HAT_CHANCE = .15;
  const RANDOM_TAPE_CRACKLE_CHANCE = .06;

  // Планирует звуки одного 1/16-шага: аккорд на начале такта, бас, барабаны, редкий лид и шум плёнки.
  function scheduleStep(track, stepIndex, time, stepDuration) {
    const bar = Math.floor(stepIndex / STEPS_PER_BAR);
    const positionInBar = stepIndex % STEPS_PER_BAR;
    const [degree, chordQuality] = track.chordProgression[bar % track.chordProgression.length];

    let root = track.rootNote + degree;
    if (root > track.rootNote + 6) root -= 12; // держим корень аккорда в пределах одной октавы

    const drumsActive = bar >= INTRO_BARS && bar < track.barCount - OUTRO_BARS;

    if (positionInBar === 0) {
      const chordNotes = CHORD_INTERVALS[chordQuality].map(interval => root + interval);
      playChord(time, chordNotes, stepDuration * STEPS_PER_BAR);
    }
    if (track.bassSteps.includes(positionInBar)) {
      playBassNote(time, root - 12, stepDuration * 3);
    }

    if (drumsActive) {
      if (track.kickSteps.includes(positionInBar)) playKick(time);
      if (positionInBar === 4 || positionInBar === 12) playNoiseHit(time, 'bandpass', 1700, .14, .2, .8);

      if (positionInBar % 2 === 0) {
        const hatPeakLevel = positionInBar % 4 ? .025 : .04;
        playNoiseHit(time, 'highpass', 7500, hatPeakLevel, .05);
      } else if (Math.random() < RANDOM_HI_HAT_CHANCE) {
        playNoiseHit(time, 'highpass', 8000, .012, .03);
      }
    }

    if (bar >= MELODY_START_BAR && positionInBar % 2 === 0 && Math.random() < track.leadDensity) {
      const scale = SCALE_INTERVALS[track.scaleMode];
      const scaleStep = scale[Math.floor(Math.random() * scale.length)];
      const octaveUp = Math.random() < .25 ? 12 : 0;
      playLeadNote(time, track.rootNote + 24 + scaleStep + octaveUp);
    }

    if (Math.random() < RANDOM_TAPE_CRACKLE_CHANCE) {
      playNoiseHit(time + Math.random() * stepDuration, 'highpass', 1200, .03 + Math.random() * .05, .004);
    }
  }

  const SCHEDULE_INTERVAL_MS = 25;
  const SCHEDULE_AHEAD_FOREGROUND_S = .2;
  const SCHEDULE_AHEAD_BACKGROUND_S = 1.5;    // в фоновой вкладке таймеры тормозят — планируем дальше вперёд
  const TRACK_GAP_S = 1.4;

  function runScheduler() {
    if (playbackMode !== 'playing' || !audioCtx) return;

    const scheduleAhead = document.hidden ? SCHEDULE_AHEAD_BACKGROUND_S : SCHEDULE_AHEAD_FOREGROUND_S;

    while (nextStepTime < audioCtx.currentTime + scheduleAhead) {
      const track = TRACKS[state.trackIndex];
      const stepDuration = 60 / track.bpm / 4;
      const swingOffset = state.step % 2 ? track.swingAmount * stepDuration : 0;

      scheduleStep(track, state.step, nextStepTime + swingOffset, stepDuration);
      nextStepTime += stepDuration;
      state.step++;

      if (state.step >= track.stepCount) {
        state.trackIndex = (state.trackIndex + 1) % TRACKS.length;
        state.step = 0;
        nextStepTime += TRACK_GAP_S;
        renderTrackInfo();
      }
    }
  }
  setInterval(runScheduler, SCHEDULE_INTERVAL_MS);

  const MUSIC_FADE_IN_S = .3;
  const MUSIC_FADE_OUT_S = .6;

  function fadeMusicBus(fadeIn) {
    const gain = musicBus.gain;
    const now = audioCtx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(fadeIn ? 1 : 0, now + (fadeIn ? MUSIC_FADE_IN_S : MUSIC_FADE_OUT_S));
  }

  /* ================= Управление плеером ================= */

  const byId = id => document.getElementById(id);

  const VOLUME_CURVE_EXPONENT = 1.6; // слайдер воспринимается на слух линейным при экспоненциальной кривой

  function getVolumeLevel() {
    return Math.pow(byId('vol').value / 100, VOLUME_CURVE_EXPONENT);
  }

  function startPlayback() {
    initAudioEngine();
    audioCtx.resume();

    const now = Date.now();
    if (playbackMode === 'paused') {
      const pauseDuration = now - pauseStartedAt;
      state.pauseMs += pauseDuration;
      if (pauseDuration >= LONG_PAUSE_MS) registerBreakTaken();
      else state.shortPauseStreak++;
    }
    if (playbackMode === 'break') {
      endBreak(now - breakStartedAt >= LONG_PAUSE_MS);
    }
    if (playbackMode === 'done') return;

    playbackMode = 'playing';
    nextStepTime = audioCtx.currentTime + .1;
    fadeMusicBus(true);
    requestWakeLock();
    renderStatus();
  }

  function pausePlayback() {
    if (playbackMode !== 'playing') return;
    playbackMode = 'paused';
    pauseStartedAt = Date.now();
    state.pauseCount++;
    fadeMusicBus(false);
    saveState();
    renderStatus();
  }

  function registerBreakTaken() {
    state.breakCount++;
    state.focusStreakMs = 0;
    state.shortPauseStreak = 0;
    state.snoozeUntil = 0;
  }

  function startBreak() {
    initAudioEngine();
    if (playbackMode === 'playing') fadeMusicBus(false);
    if (playbackMode === 'paused') state.pauseMs += Date.now() - pauseStartedAt;

    const breakDurationMs = (state.breakCount + 1) % LONG_BREAK_EVERY === 0 ? LONG_BREAK_MS : SHORT_BREAK_MS;
    playbackMode = 'break';
    breakStartedAt = Date.now();
    breakEndsAt = breakStartedAt + breakDurationMs;
    hideAlert();
    saveState();
    renderStatus();
  }

  function endBreak(wasCounted) {
    if (wasCounted) registerBreakTaken();
    breakEndsAt = 0;
    hideAlert();
  }

  function skipTrack(direction) {
    initAudioEngine();
    state.trackIndex = (state.trackIndex + direction + TRACKS.length) % TRACKS.length;
    state.step = 0;
    if (audioCtx) nextStepTime = audioCtx.currentTime + .15;
    renderTrackInfo();
    saveState();
  }

  byId('play').onclick = () => (playbackMode === 'playing' ? pausePlayback() : startPlayback());
  byId('prev').onclick = () => skipTrack(-1);
  byId('next').onclick = () => skipTrack(1);
  byId('brk').onclick = () => (playbackMode === 'break' ? startPlayback() : startBreak());
  byId('vol').oninput = () => {
    if (masterGain) masterGain.gain.setTargetAtTime(getVolumeLevel(), audioCtx.currentTime, .05);
  };

  const RESET_CONFIRM_WINDOW_MS = 3000;
  let resetConfirmArmedAt = 0;

  byId('reset').onclick = () => {
    const resetButton = byId('reset');

    if (Date.now() - resetConfirmArmedAt > RESET_CONFIRM_WINDOW_MS) {
      resetConfirmArmedAt = Date.now();
      resetButton.textContent = 'Точно? Жми ещё раз';
      resetButton.classList.add('hot');
      return;
    }

    if (audioCtx && playbackMode === 'playing') fadeMusicBus(false);
    state = createFreshState();
    playbackMode = 'stopped';
    hideAlert();
    saveState();
    renderTrackInfo();
    renderStatus();

    resetButton.textContent = 'Новая смена';
    resetButton.classList.remove('hot');
  };

  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && event.target.tagName !== 'INPUT') {
      event.preventDefault();
      byId('play').click();
    }
  });

  /* Wake Lock — чтобы экран не гас во время смены. */

  let wakeLockSentinel = null;

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
      }
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && playbackMode === 'playing') requestWakeLock();
    saveState();
  });
  addEventListener('pagehide', saveState);

  /* Media Session — кнопки на экране блокировки, где поддерживается. */

  try {
    navigator.mediaSession.setActionHandler('play', startPlayback);
    navigator.mediaSession.setActionHandler('pause', pausePlayback);
    navigator.mediaSession.setActionHandler('nexttrack', () => skipTrack(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => skipTrack(-1));
  } catch {}

  /* ================= Алерты ================= */

  function showAlert(kind, message, buttons) {
    activeAlertKind = kind;
    byId('alertText').textContent = message;

    const buttonRow = byId('alertRow');
    buttonRow.innerHTML = '';
    buttons.forEach(([label, onClick, isPrimary]) => {
      const button = document.createElement('button');
      button.className = isPrimary ? 'ghost hot' : 'ghost';
      button.textContent = label;
      button.onclick = onClick;
      buttonRow.append(button);
    });

    byId('alert').hidden = false;
  }

  function hideAlert() {
    activeAlertKind = '';
    byId('alert').hidden = true;
  }

  /* ================= Тик таймера ================= */

  const TICK_INTERVAL_MS = 250;
  const SAVE_INTERVAL_MS = 5000;
  const MAX_TICK_STEP_MS = 5000;           // ограничиваем скачок dt после, например, приостановки вкладки
  const SHORT_PAUSE_STREAK_WARNING = 3;

  let lastTickAt = Date.now();

  function tickTimer() {
    const now = Date.now();
    const elapsed = Math.min(now - lastTickAt, MAX_TICK_STEP_MS);
    lastTickAt = now;

    if (playbackMode === 'playing') {
      state.playedMs += elapsed;
      state.focusStreakMs += elapsed;

      if (state.playedMs >= SHIFT_DURATION_MS) {
        playbackMode = 'done';
        fadeMusicBus(false);
        playChime();
        hideAlert();
        showAlert('shiftDone', 'Восемь часов отработано. Смена закрыта, выключай кассету.', [
          ['Новая смена', () => byId('reset').click()],
        ]);
      } else if (state.focusStreakMs >= FOCUS_BLOCK_MS && now >= state.snoozeUntil && activeAlertKind !== 'breakDue') {
        const breakMinutes = (state.breakCount + 1) % LONG_BREAK_EVERY === 0 ? 20 : 10;
        playChime();
        notifyUser('Пора сделать перерыв', `${breakMinutes} минут: встань, пройдись, посмотри вдаль.`);
        showAlert(
          'breakDue',
          `Ты в фокусе ${formatMinutes(state.focusStreakMs)}. Время на перерыв ${breakMinutes} минут: встань, разомнись, посмотри в окно.`,
          [
            ['Начать перерыв', startBreak, true],
            ['Ещё 10 минут', () => { state.snoozeUntil = Date.now() + SNOOZE_MS; hideAlert(); }],
          ],
        );
      }
    }

    if (playbackMode === 'break' && breakEndsAt && now >= breakEndsAt) {
      endBreak(true);
      playbackMode = 'ready'; // перерыв засчитан, ждём возвращения
      playChime();
      notifyUser('Перерыв окончен', 'Возвращайся к работе.');
      showAlert('breakEnded', 'Перерыв окончен. Новый блок фокуса — 50 минут.', [
        ['▶ Продолжить', startPlayback, true],
      ]);
    }

    renderStatus();
  }
  setInterval(tickTimer, TICK_INTERVAL_MS);
  setInterval(saveState, SAVE_INTERVAL_MS);

  const APP_TITLE = 'Неоновая кассета';
  const TITLE_RESET_DELAY_MS = 15_000;

  function notifyUser(title, body) {
    document.title = '● ' + title;
    setTimeout(() => { document.title = APP_TITLE; }, TITLE_RESET_DELAY_MS);
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch {}
  }

  /* ================= Отрисовка ================= */

  const padZero = n => String(n).padStart(2, '0');

  function formatHMS(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)}`;
  }

  function formatMinSec(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${padZero(minutes)}:${padZero(seconds)}`;
  }

  function formatMinutes(ms) {
    const totalMinutes = Math.round(ms / MINUTE_MS);
    return totalMinutes >= 60
      ? `${Math.floor(totalMinutes / 60)} ч ${totalMinutes % 60} мин`
      : `${totalMinutes} мин`;
  }

  function formatTrackTime(seconds) {
    return `${Math.floor(seconds / 60)}:${padZero(Math.floor(seconds % 60))}`;
  }

  function renderTrackInfo() {
    const track = TRACKS[state.trackIndex];
    byId('tName').textContent = track.name;
    byId('tNum').textContent = `${padZero(state.trackIndex + 1)}/${padZero(TRACKS.length)}`;
    byId('tInfo').textContent = `${track.bpm} BPM · ${track.keyLabel}`;

    [...byId('playlist').children].forEach((item, index) => {
      item.classList.toggle('cur', index === state.trackIndex);
    });

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: 'Neon/Tape',
        album: 'Focus Shift',
      });
    } catch {}
  }

  byId('playlist').innerHTML = TRACKS.map((track, index) => (
    `<li data-i="${index}"><span>${padZero(index + 1)} · ${track.name}</span><span>${track.bpm} BPM · ${formatTrackTime(track.lengthSeconds)}</span></li>`
  )).join('');

  byId('playlist').onclick = event => {
    const item = event.target.closest('li');
    if (item) skipTrack(Number(item.dataset.i) - state.trackIndex);
  };

  const STATUS_LABELS = {
    stopped: 'STOP',
    playing: '▶ PLAY',
    paused: '❚❚ PAUSE',
    break: '☕ BREAK',
    ready: 'READY',
    done: '■ END',
  };

  // Текст подсказки под плеером — зависит от текущего режима и состояния смены.
  function buildHintMessage(now, breakRemainingMs) {
    if (playbackMode === 'stopped') {
      return state.playedMs
        ? `Смена на паузе: отработано <b>${formatMinutes(state.playedMs)}</b>. Жми PLAY, чтобы продолжить.`
        : 'Нажми <b>PLAY</b>, чтобы начать смену. Музыка генерируется прямо в браузере, без интернета.';
    }
    if (playbackMode === 'ready') {
      return 'Перерыв засчитан. Жми <b>PLAY</b>, когда будешь готов.';
    }
    if (playbackMode === 'done') {
      return 'Смена закрыта. Завтра начнётся новая автоматически.';
    }
    if (playbackMode === 'break') {
      return `Перерыв: осталось <b>${formatMinSec(breakRemainingMs)}</b>. Отойди от экрана, музыка подождёт.`;
    }
    if (state.shortPauseStreak >= SHORT_PAUSE_STREAK_WARNING) {
      return `<b>${state.shortPauseStreak} коротких пауз</b> за один блок. Фокус рвётся: лучше честный перерыв на 10 минут, чем дёргаться.`;
    }
    if (playbackMode === 'paused') {
      const pausedFor = now - pauseStartedAt;
      return pausedFor >= LONG_PAUSE_MS
        ? `Пауза ${formatMinSec(pausedFor)} — засчитаю как перерыв, когда вернёшься.`
        : `Пауза ${formatMinSec(pausedFor)}. После 5 минут она засчитается как перерыв.`;
    }

    const timeLeftInBlock = FOCUS_BLOCK_MS - state.focusStreakMs;
    return timeLeftInBlock > 0
      ? `До перерыва <b>${formatMinutes(timeLeftInBlock)}</b>. До конца смены ${formatMinutes(SHIFT_DURATION_MS - state.playedMs)}.`
      : 'Перерыв просрочен. Глазам и спине он нужнее, чем кажется.';
  }

  function renderStatus() {
    const now = Date.now();
    const track = TRACKS[state.trackIndex];

    byId('sess').firstChild.textContent = formatHMS(state.playedMs);
    byId('shiftBar').style.width = `${Math.min(100, (state.playedMs / SHIFT_DURATION_MS) * 100)}%`;

    const breakRemainingMs = playbackMode === 'break' ? breakEndsAt - now : 0;
    byId('focus').textContent = playbackMode === 'break' ? formatMinSec(breakRemainingMs) : formatMinSec(state.focusStreakMs);

    const totalPauseMs = state.pauseMs + (playbackMode === 'paused' ? now - pauseStartedAt : 0);
    byId('pauses').textContent = `${state.pauseCount} · ${Math.round(totalPauseMs / MINUTE_MS)}м`;
    byId('breaks').textContent = state.breakCount;
    byId('tTime').textContent = `${formatTrackTime((state.step / track.stepCount) * track.lengthSeconds)} / ${formatTrackTime(track.lengthSeconds)}`;
    byId('state').textContent = STATUS_LABELS[playbackMode];

    const playButton = byId('play');
    playButton.classList.toggle('on', playbackMode === 'playing');
    playButton.textContent = playbackMode === 'playing' ? '❚❚ PAUSE' : '▶ PLAY';
    playButton.setAttribute('aria-label', playbackMode === 'playing' ? 'Пауза' : 'Играть');
    byId('brk').textContent = playbackMode === 'break' ? 'ЗАКОНЧИТЬ' : 'ПЕРЕРЫВ';

    byId('hint').innerHTML = buildHintMessage(now, breakRemainingMs);
  }

  /* ================= Катушки кассеты ================= */

  const LEFT_REEL_X = 112;
  const RIGHT_REEL_X = 228;
  const REEL_Y = 107;
  const TAPE_LEFT_ANCHOR_X = 92;
  const TAPE_RIGHT_ANCHOR_X = 248;
  const TAPE_ANCHOR_Y = 172;
  const REEL_RADIUS_MIN = 18;
  const REEL_RADIUS_MAX = 44;
  const TAPE_LINEAR_SPEED = 140;   // скорость плёнки в px/сек, пересчитывается в угловую для каждой катушки
  const VU_METER_GAIN = 6;
  const RAD_TO_DEG = 180 / Math.PI;
  const SPOKE_COUNT = 6;

  function drawHubSpokes(group) {
    let markup = '<circle r="13" fill="#d9d3e3"/><circle r="6" fill="#07060b"/>';
    for (let i = 0; i < SPOKE_COUNT; i++) {
      const angle = i * (360 / SPOKE_COUNT);
      markup += `<rect x="-1.6" y="-11" width="3.2" height="4" fill="#07060b" transform="rotate(${angle})"/>`;
    }
    group.innerHTML = markup;
  }
  drawHubSpokes(byId('hubL'));
  drawHubSpokes(byId('hubR'));

  let reelAngles = [0, 0];
  let lastFrameAt = performance.now();

  function animateReels(timestamp) {
    const dt = (timestamp - lastFrameAt) / 1000;
    lastFrameAt = timestamp;

    const track = TRACKS[state.trackIndex];
    const progress = state.step / track.stepCount;

    // Плёнка перематывается с левой катушки на правую — радиус зависит от того, сколько плёнки осталось с каждой стороны.
    const leftRadius = Math.sqrt(REEL_RADIUS_MIN ** 2 + (REEL_RADIUS_MAX ** 2 - REEL_RADIUS_MIN ** 2) * (1 - progress));
    const rightRadius = Math.sqrt(REEL_RADIUS_MIN ** 2 + (REEL_RADIUS_MAX ** 2 - REEL_RADIUS_MIN ** 2) * progress);

    byId('packL').setAttribute('r', leftRadius.toFixed(1));
    byId('packR').setAttribute('r', rightRadius.toFixed(1));
    byId('tapeLines').innerHTML =
      `<path d="M${LEFT_REEL_X - leftRadius} ${REEL_Y} L${TAPE_LEFT_ANCHOR_X} ${TAPE_ANCHOR_Y} H${TAPE_RIGHT_ANCHOR_X} L${RIGHT_REEL_X + rightRadius} ${REEL_Y}"/>`;

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (playbackMode === 'playing' && !reducedMotion) {
      reelAngles[0] += (TAPE_LINEAR_SPEED / leftRadius) * dt * RAD_TO_DEG;
      reelAngles[1] += (TAPE_LINEAR_SPEED / rightRadius) * dt * RAD_TO_DEG;
    }
    byId('hubL').setAttribute('transform', `translate(${LEFT_REEL_X} ${REEL_Y}) rotate(${reelAngles[0] % 360})`);
    byId('hubR').setAttribute('transform', `translate(${RIGHT_REEL_X} ${REEL_Y}) rotate(${reelAngles[1] % 360})`);

    if (levelAnalyser) {
      const samples = new Uint8Array(levelAnalyser.fftSize);
      levelAnalyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) sumSquares += ((sample - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sumSquares / samples.length) * VU_METER_GAIN);
      byId('vuL').style.width = `${level * 100}%`;
      byId('vuR').style.width = `${Math.min(1, level * (.85 + Math.random() * .25)) * 100}%`;
    }

    requestAnimationFrame(animateReels);
  }
  requestAnimationFrame(animateReels);

  /* ================= Инициализация ================= */

  renderTrackInfo();
  renderStatus();

  // Service worker регистрируется только в собранной версии (где есть manifest).
  if (document.querySelector('link[rel="manifest"]') && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
