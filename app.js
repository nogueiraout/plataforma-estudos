/**
 * NutriPrep 360° — Lógica Principal
 * Persistência em localStorage, banco modular, simulador de adipômetro SVG,
 * estação prática ISAK, calculadoras clínicas e importador JSON.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "nutriprep360_state_v1";

  const CHECKLIST_ITEMS = [
    "Zerei/tarei a balança mecânica antes de pesar o avaliado?",
    "Avaliei exclusivamente o hemicorpo direito (padrão ISAK)?",
    "Marquei o ponto anatômico com caneta dermatográfica e trena metálica?",
    "Pincei a dobra 1 cm acima/proximal ao ponto e mantive os dedos firmes?",
    "Apliquei as hastes do adipômetro perpendicularmente à dobra?",
    "Aguardei ~2 segundos para ler o mostrador e abri as hastes antes de retirar?",
    "Fiz medidas rotacionais e realizei 3ª medida se diferença > 5% (usando mediana)?"
  ];

  /* ========================================================================
     Utilitários
     ======================================================================== */

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(window.NUTRIPREP_DEFAULT_DATA.modules));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseDecimal(raw) {
    if (typeof raw !== "string") return NaN;
    return parseFloat(raw.trim().replace(",", "."));
  }

  function fmt(num, digits = 2) {
    return Number(num).toFixed(digits).replace(".", ",");
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || `mod_${Date.now()}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch (_) {
      // Silencioso caso o navegador bloqueie áudio automático
    }
  }

  /* ========================================================================
     Estado Persistente (localStorage)
     ======================================================================== */

  function loadState() {
    const defaults = {
      theme: "light",
      activeModule: "avaliacao",
      activeTab: "questoes",
      modules: cloneDefaults(),
      answers: {}, // { [questionId]: selectedOptionIndex }
      caliperStats: { correct: 0, total: 0, streak: 0 },
      stationsCompleted: 0
    };

    try {
      const savedRaw = localStorage.getItem(STORAGE_KEY);
      if (!savedRaw) return defaults;
      const saved = JSON.parse(savedRaw);
      const mergedModules = cloneDefaults();

      // Preserva módulos salvos pelo usuário e novas questões importadas
      if (saved.modules && typeof saved.modules === "object") {
        Object.keys(saved.modules).forEach((key) => {
          const mod = saved.modules[key];
          if (mod && Array.isArray(mod.questions)) {
            mergedModules[key] = mod;
          }
        });
      }

      const activeModule = mergedModules[saved.activeModule]
        ? saved.activeModule
        : "avaliacao";

      return {
        theme: saved.theme === "dark" ? "dark" : "light",
        activeModule,
        activeTab: saved.activeTab || "questoes",
        modules: mergedModules,
        answers: saved.answers && typeof saved.answers === "object" ? saved.answers : {},
        caliperStats: saved.caliperStats || defaults.caliperStats,
        stationsCompleted: Number(saved.stationsCompleted) || 0
      };
    } catch (_) {
      return defaults;
    }
  }

  let state = loadState();

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // Ignora erro de cota se o navegador estiver em modo restrito
    }
  }

  /* ========================================================================
     Tema Claro / Escuro (Sun / Moon Toggle)
     ======================================================================== */

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    const sun = document.getElementById("themeSun");
    const moon = document.getElementById("themeMoon");
    if (sun && moon) {
      sun.classList.toggle("active", !isDark);
      moon.classList.toggle("active", isDark);
    }
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme(state.theme);
    saveState();
  }

  /* ========================================================================
     Navegação: Abas e Seletor de Módulos em Chips
     ======================================================================== */

  const TABS = ["questoes", "adipometro", "pratica", "calculadora", "importador"];

  const MODULE_VISUALS = {
    avaliacao:     { icon: "📏", tone: "chip-mint" },
    enare_clinica: { icon: "🏥", tone: "chip-coral" },
    enare_materno: { icon: "🍼", tone: "chip-lilac" },
    enare_sus:     { icon: "🌿", tone: "chip-lime" }
  };

  const EXTRA_TONES = ["chip-gold", "chip-mint", "chip-coral", "chip-lilac", "chip-lime"];

  function setTab(tab) {
    if (!TABS.includes(tab)) tab = "questoes";
    state.activeTab = tab;
    saveState();

    TABS.forEach((t) => {
      const view = document.getElementById(`view-${t}`);
      const btn = document.getElementById(`tab-${t}`);
      const isActive = t === tab;
      view.classList.toggle("hidden", !isActive);
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
    });

    if (tab === "importador") {
      renderStats();
    }
  }

  function populateModuleSelectors() {
    const chipsContainer = document.getElementById("moduleChips");
    const importSelect = document.getElementById("importTargetModule");
    const keys = Object.keys(state.modules);

    if (!state.modules[state.activeModule]) {
      state.activeModule = keys[0];
    }

    chipsContainer.innerHTML = keys
      .map((k, idx) => {
        const m = state.modules[k];
        const vis = MODULE_VISUALS[k] || { icon: "📚", tone: EXTRA_TONES[idx % EXTRA_TONES.length] };
        const isActive = k === state.activeModule;
        return `
          <button type="button" class="module-chip ${isActive ? "active" : ""}" data-module="${escapeHtml(k)}" aria-pressed="${isActive}">
            <span class="module-chip-icon ${vis.tone}" aria-hidden="true">${vis.icon}</span>
            <span>${escapeHtml(m.name)}</span>
            <span class="module-chip-count">${m.questions.length}</span>
          </button>
        `;
      })
      .join("");

    chipsContainer.querySelectorAll(".module-chip").forEach((btn) => {
      btn.addEventListener("click", () => switchModule(btn.dataset.module));
    });

    importSelect.innerHTML = keys
      .map((k) => {
        const m = state.modules[k];
        return `<option value="${escapeHtml(k)}">${escapeHtml(m.name)} (${m.questions.length})</option>`;
      })
      .join("");
    importSelect.value = state.activeModule;
  }

  function switchModule(moduleId) {
    if (!state.modules[moduleId]) return;
    state.activeModule = moduleId;
    qState.topicFilter = "ALL";
    qState.reviewWrongOnly = false;
    qState.shuffledOrder = null;
    qState.index = 0;
    saveState();

    populateModuleSelectors();
    rebuildTopicFilter();
    renderQuestionView();
    showToast(`Módulo ativo: ${state.modules[moduleId].name}`);
  }

  /* ========================================================================
     ABA 1: Banco de Questões & Cascata
     ======================================================================== */

  const qState = {
    topicFilter: "ALL",
    reviewWrongOnly: false,
    shuffledOrder: null,
    index: 0
  };

  function getActiveModule() {
    return state.modules[state.activeModule];
  }

  function getFilteredQuestions() {
    const mod = getActiveModule();
    let list = mod.questions.slice();

    if (qState.shuffledOrder && qState.shuffledOrder.length === list.length) {
      const byId = new Map(list.map((q) => [q.id, q]));
      const ordered = qState.shuffledOrder.map((id) => byId.get(id)).filter(Boolean);
      if (ordered.length === list.length) list = ordered;
    }

    if (qState.topicFilter !== "ALL") {
      list = list.filter((q) => q.topic === qState.topicFilter);
    }

    if (qState.reviewWrongOnly) {
      list = list.filter((q) => {
        const chosen = state.answers[q.id];
        return chosen !== undefined && chosen !== q.answer;
      });
    }

    return list;
  }

  function rebuildTopicFilter() {
    const mod = getActiveModule();
    const select = document.getElementById("topicFilter");
    const topics = Array.from(new Set(mod.questions.map((q) => q.topic)));
    select.innerHTML =
      `<option value="ALL">Todos os tópicos (${mod.questions.length})</option>` +
      topics
        .map((t) => {
          const count = mod.questions.filter((q) => q.topic === t).length;
          return `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${count})</option>`;
        })
        .join("");
    select.value = qState.topicFilter;
  }

  function updateModuleMetrics() {
    const mod = getActiveModule();
    const total = mod.questions.length;
    let answered = 0;
    let correct = 0;
    let wrong = 0;

    mod.questions.forEach((q) => {
      const chosen = state.answers[q.id];
      if (chosen !== undefined) {
        answered++;
        if (chosen === q.answer) correct++;
        else wrong++;
      }
    });

    const pct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
    document.getElementById("scoreBadge").textContent = `Acertos: ${correct} / ${answered} (${pct}%)`;

    const wrongBadge = document.getElementById("wrongBadge");
    if (wrong > 0) {
      wrongBadge.textContent = `Erradas: ${wrong}`;
      wrongBadge.classList.remove("hidden");
    } else {
      wrongBadge.classList.add("hidden");
    }

    const reviewBtn = document.getElementById("btnReviewWrong");
    reviewBtn.classList.toggle("btn-primary", qState.reviewWrongOnly);
    reviewBtn.classList.toggle("btn-ghost", !qState.reviewWrongOnly);
    reviewBtn.textContent = qState.reviewWrongOnly
      ? "✕ Sair da Revisão de Erradas"
      : `🎯 Revisar Erradas (${wrong})`;

    const progressPct = total > 0 ? Math.round((answered / total) * 100) : 0;
    document.getElementById("progressFill").style.width = `${progressPct}%`;
  }

  function renderQuestionView() {
    const mod = getActiveModule();
    document.getElementById("moduleTitle").textContent = mod.name;
    document.getElementById("moduleSubtitle").textContent = mod.subtitle || "Banco de questões modular";

    updateModuleMetrics();

    const list = getFilteredQuestions();
    const container = document.getElementById("questionContainer");

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem 1rem;">
          <p class="section-title" style="font-size: 1.05rem;">Nenhuma questão neste filtro</p>
          <p class="section-sub" style="margin-bottom: 1rem;">
            ${
              qState.reviewWrongOnly
                ? "Parabéns! Você não tem questões erradas pendentes neste módulo."
                : "Este módulo ainda não possui questões. Importe via JSON na aba Gerenciar & Importar."
            }
          </p>
          ${
            qState.reviewWrongOnly
              ? `<button type="button" class="btn btn-primary" id="btnClearWrongFilter">Voltar a todas as questões</button>`
              : `<button type="button" class="btn btn-primary" id="btnGoImport">Ir para Importador JSON</button>`
          }
        </div>
      `;
      const clearBtn = document.getElementById("btnClearWrongFilter");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          qState.reviewWrongOnly = false;
          qState.index = 0;
          renderQuestionView();
        });
      }
      const importBtn = document.getElementById("btnGoImport");
      if (importBtn) {
        importBtn.addEventListener("click", () => setTab("importador"));
      }
      return;
    }

    if (qState.index >= list.length) qState.index = 0;
    if (qState.index < 0) qState.index = list.length - 1;

    const item = list[qState.index];
    const chosen = state.answers[item.id];
    const isAnswered = chosen !== undefined;

    const optionsHtml = item.options
      .map((opt, idx) => {
        let cls = "option-btn";
        if (isAnswered) {
          if (idx === item.answer) cls += " correct";
          else if (idx === chosen) cls += " wrong";
        }
        return `
          <button type="button" class="${cls}" data-opt="${idx}" ${isAnswered ? "disabled" : ""}>
            <span class="option-letter">${String.fromCharCode(65 + idx)}</span>
            <span>${escapeHtml(opt)}</span>
          </button>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="q-meta">
        <div class="toolbar-group">
          <span class="q-topic">${escapeHtml(item.topic)}</span>
          ${item.tag ? `<span class="badge badge-info">${escapeHtml(item.tag)}</span>` : ""}
        </div>
        <span class="field-hint">Questão ${qState.index + 1} de ${list.length}</span>
      </div>

      <p class="q-stem">${escapeHtml(item.q)}</p>

      <div class="options-list">${optionsHtml}</div>

      ${
        isAnswered
          ? `<div class="explanation-box">
               <strong>${chosen === item.answer ? "✅ Gabarito Comentado:" : "❌ Atenção — Gabarito Comentado:"}</strong>
               ${escapeHtml(item.explanation)}
             </div>`
          : ""
      }

      <div class="q-footer">
        <span class="kbd-hint">Atalhos: <kbd>A</kbd>–<kbd>D</kbd> responder • <kbd>←</kbd> <kbd>→</kbd> navegar</span>
        <div class="toolbar-group">
          ${
            isAnswered
              ? `<button type="button" id="btnRedoOne" class="btn btn-ghost btn-sm">Refazer esta</button>`
              : ""
          }
          <button type="button" id="btnPrevQ" class="btn btn-secondary btn-sm">← Anterior</button>
          <button type="button" id="btnNextQ" class="btn btn-primary btn-sm">Próxima →</button>
        </div>
      </div>
    `;

    container.querySelectorAll(".option-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.opt);
        answerCurrentQuestion(item, idx);
      });
    });

    document.getElementById("btnPrevQ").addEventListener("click", () => {
      qState.index = (qState.index - 1 + list.length) % list.length;
      renderQuestionView();
    });

    document.getElementById("btnNextQ").addEventListener("click", () => {
      qState.index = (qState.index + 1) % list.length;
      renderQuestionView();
    });

    const redoBtn = document.getElementById("btnRedoOne");
    if (redoBtn) {
      redoBtn.addEventListener("click", () => {
        delete state.answers[item.id];
        saveState();
        renderQuestionView();
      });
    }
  }

  function answerCurrentQuestion(item, selectedIdx) {
    if (state.answers[item.id] !== undefined) return;
    state.answers[item.id] = selectedIdx;
    saveState();
    renderQuestionView();
  }

  /* ========================================================================
     ABA 2: Simulador Visual de Adipômetro Analógico
     ======================================================================== */

  const caliperState = {
    targetMm: 14.5,
    mode: "half", // "half" | "fine" | "cascade"
    cascadeCb: 30.0,
    hintVisible: false,
    solvedCurrent: false
  };

  function polarToCartesian(cx, cy, radius, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad)
    };
  }

  function describeArc(cx, cy, radius, startAngle, endAngle) {
    if (endAngle <= 0.1) return "";
    const start = polarToCartesian(cx, cy, radius, endAngle);
    const end = polarToCartesian(cx, cy, radius, startAngle);
    const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  }

  function initDialSvg() {
    const outerGroup = document.getElementById("dialTicks");
    const subGroup = document.getElementById("subDialTicks");

    // 100 divisões = 0,1 mm por traço; 0,5 mm médio; 1,0 mm maior com número
    let outerHtml = "";
    for (let i = 0; i < 100; i++) {
      const angle = (i / 100) * 360;
      const isMajor = i % 10 === 0;
      const isHalf = !isMajor && i % 5 === 0;
      const isMinorEven = !isMajor && !isHalf && i % 2 === 0;

      if (!isMajor && !isHalf && !isMinorEven) continue; // Mostra traços a cada 0,2 mm + 0,5 mm + 1,0 mm

      const rOuter = 118;
      const rInner = isMajor ? 104 : isHalf ? 108 : 112;
      const p1 = polarToCartesian(140, 140, rOuter, angle);
      const p2 = polarToCartesian(140, 140, rInner, angle);
      const stroke = isMajor ? "#0f172a" : isHalf ? "#059669" : "#64748b";
      const width = isMajor ? 2.4 : isHalf ? 1.8 : 1;

      outerHtml += `<line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" stroke="${stroke}" stroke-width="${width}" />`;

      if (isMajor) {
        const labelPos = polarToCartesian(140, 140, 91, angle);
        const digit = i / 10;
        outerHtml += `<text x="${labelPos.x.toFixed(2)}" y="${(labelPos.y + 4.5).toFixed(2)}" text-anchor="middle" font-size="13.5" font-weight="800" fill="#0f172a">${digit}</text>`;
      }
    }
    outerGroup.innerHTML = outerHtml;

    // Sub-mostrador: 5 voltas (0, 1, 2, 3, 4 => 0 a 50 mm)
    let subHtml = "";
    for (let t = 0; t < 10; t++) {
      const angle = (t / 10) * 360;
      const isFull = t % 2 === 0;
      const p1 = polarToCartesian(140, 186, 30, angle);
      const p2 = polarToCartesian(140, 186, isFull ? 25 : 27, angle);
      subHtml += `<line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" stroke="${isFull ? "#0f172a" : "#64748b"}" stroke-width="${isFull ? 1.8 : 1}" />`;

      if (isFull) {
        const lp = polarToCartesian(140, 186, 19, angle);
        subHtml += `<text x="${lp.x.toFixed(2)}" y="${(lp.y + 3).toFixed(2)}" text-anchor="middle" font-size="9" font-weight="800" fill="#0f172a">${t / 2}</text>`;
      }
    }
    subGroup.innerHTML = subHtml;

    updateCaliperStatsUI();
    generateCaliper();
  }

  function updateCaliperStatsUI() {
    const s = state.caliperStats;
    document.getElementById("caliperScoreBadge").textContent = `Acertos: ${s.correct} / ${s.total}`;
    document.getElementById("caliperStreakBadge").textContent = `Sequência: ${s.streak}`;
  }

  function generateCaliper() {
    const mode = document.getElementById("caliperMode").value;
    caliperState.mode = mode;
    caliperState.solvedCurrent = false;
    caliperState.hintVisible = false;

    let value;
    if (mode === "fine") {
      // 4.2 a 43.8 mm em passos de 0.2 mm
      const steps = Math.floor(Math.random() * 198) + 21;
      value = Number((steps * 0.2).toFixed(1));
    } else {
      // 5.5 a 42.5 mm em passos de 0.5 mm
      const steps = Math.floor(Math.random() * 75) + 11;
      value = Number((steps * 0.5).toFixed(1));
    }
    caliperState.targetMm = value;

    const remainder = Number((value % 10).toFixed(2));
    const bigAngle = (remainder / 10) * 360;
    const smallAngle = (value / 50) * 360; // 5 voltas completas = 50 mm

    document.getElementById("bigHand").setAttribute("transform", `rotate(${bigAngle} 140 140)`);
    document.getElementById("bigHandTail").setAttribute("transform", `rotate(${bigAngle} 140 140)`);
    document.getElementById("smallHand").setAttribute("transform", `rotate(${smallAngle} 140 186)`);

    const arc = document.getElementById("dialGuideArc");
    arc.setAttribute("d", describeArc(140, 140, 111, 0, bigAngle));
    arc.classList.add("hidden");

    const cascadeBox = document.getElementById("cascadeContext");
    const cmbInput = document.getElementById("cascadeCmbInput");
    const promptBox = document.getElementById("caliperPromptBox");

    if (mode === "cascade") {
      caliperState.cascadeCb = Number((26 + Math.floor(Math.random() * 19) * 0.5).toFixed(1));
      promptBox.innerHTML = `
        <h3 class="section-title" style="font-size: 1.1rem;">Desafio em Cascata: Adipômetro (PCT) → CMB</h3>
        <p class="section-sub" style="margin-top: 0.35rem;">
          Leia a Prega Cutânea Tricipital (PCT) no mostrador ao lado e calcule a <strong>Circunferência Muscular do Braço (CMB)</strong>.
        </p>
      `;
      cascadeBox.innerHTML = `
        <strong>Dados do avaliado:</strong> Circunferência do Braço (CB) = <span class="result-highlight">${fmt(caliperState.cascadeCb, 1)} cm</span>.<br />
        <span class="field-hint">Fórmula: CMB = CB − (π × PCT em cm). Lembre-se de dividir a PCT (mm) por 10!</span>
      `;
      cascadeBox.classList.remove("hidden");
      cmbInput.classList.remove("hidden");
      cmbInput.value = "";
    } else {
      promptBox.innerHTML = `
        <h3 class="section-title" style="font-size: 1.1rem;">Qual é a leitura exata deste adipômetro (em mm)?</h3>
        <p class="section-sub" style="margin-top: 0.35rem;">
          Observe primeiro o <strong>ponteiro vermelho</strong> (voltas de 10 mm) e some ao valor do <strong>ponteiro preto</strong>.
        </p>
      `;
      cascadeBox.classList.add("hidden");
      cmbInput.classList.add("hidden");
    }

    const input = document.getElementById("caliperInput");
    input.value = "";
    const fb = document.getElementById("caliperFeedback");
    fb.className = "feedback-banner hidden";
    fb.innerHTML = "";
  }

  function toggleDialHint() {
    caliperState.hintVisible = !caliperState.hintVisible;
    const arc = document.getElementById("dialGuideArc");
    arc.classList.toggle("hidden", !caliperState.hintVisible);

    const fb = document.getElementById("caliperFeedback");
    if (caliperState.hintVisible && fb.classList.contains("hidden")) {
      const turns = Math.floor(caliperState.targetMm / 10);
      fb.className = "feedback-banner info";
      fb.innerHTML = `💡 <strong>Dica:</strong> O ponteiro vermelho já passou do número <strong>${turns}</strong> (${turns * 10} mm). Agora leia onde o ponteiro preto aponta na faixa dourada (0 a 10 mm) e some!`;
    }
  }

  function checkCaliper() {
    const rawVal = parseDecimal(document.getElementById("caliperInput").value);
    const fb = document.getElementById("caliperFeedback");

    if (Number.isNaN(rawVal)) {
      fb.className = "feedback-banner err";
      fb.innerHTML = "Digite um valor numérico para a leitura do adipômetro (ex: 14,5).";
      return;
    }

    const target = caliperState.targetMm;
    const turns = Math.floor(target / 10);
    const rem = Number((target % 10).toFixed(1));
    const tol = caliperState.mode === "fine" ? 0.15 : 0.2;
    const dialOk = Math.abs(rawVal - target) <= tol;

    if (caliperState.mode === "cascade") {
      const rawCmb = parseDecimal(document.getElementById("cascadeCmbInput").value);
      if (Number.isNaN(rawCmb)) {
        fb.className = "feedback-banner err";
        fb.innerHTML = "Preencha também o campo da <strong>CMB (cm)</strong> para completar a questão em cascata.";
        return;
      }

      const expectedCmb = caliperState.cascadeCb - Math.PI * (target / 10);
      const forgotConvertCmb = caliperState.cascadeCb - Math.PI * target;
      const cmbOk = Math.abs(rawCmb - expectedCmb) <= 0.15;

      if (!caliperState.solvedCurrent) {
        state.caliperStats.total++;
        if (dialOk && cmbOk) {
          state.caliperStats.correct++;
          state.caliperStats.streak++;
        } else {
          state.caliperStats.streak = 0;
        }
        caliperState.solvedCurrent = true;
        saveState();
        updateCaliperStatsUI();
      }

      if (dialOk && cmbOk) {
        fb.className = "feedback-banner ok";
        fb.innerHTML = `✅ <strong>Perfeito na cascata!</strong> PCT = <strong>${fmt(target, 1)} mm</strong> (${fmt(target / 10, 2)} cm) → CMB = ${fmt(caliperState.cascadeCb, 1)} − (3,1416 × ${fmt(target / 10, 2)}) = <strong>${fmt(expectedCmb, 2)} cm</strong>.`;
      } else {
        let diag = "";
        if (!dialOk) {
          diag += `• Leitura correta do adipômetro: <strong>${fmt(target, 1)} mm</strong> (${turns} volta(s) = ${turns * 10} mm + ${fmt(rem, 1)} mm).<br/>`;
        } else {
          diag += `• Leitura do adipômetro correta (<strong>${fmt(target, 1)} mm</strong>)!<br/>`;
        }
        if (!cmbOk) {
          if (Math.abs(rawCmb - forgotConvertCmb) <= 0.5) {
            diag += `• <strong>Erro clássico de unidade:</strong> você usou a PCT em mm sem dividir por 10! `;
          }
          diag += `• CMB correta = ${fmt(caliperState.cascadeCb, 1)} − (3,1416 × ${fmt(target / 10, 2)}) = <strong>${fmt(expectedCmb, 2)} cm</strong>.`;
        }
        fb.className = "feedback-banner err";
        fb.innerHTML = `❌ <strong>Revise o passo a passo:</strong><br/>${diag}`;
        document.getElementById("dialGuideArc").classList.remove("hidden");
      }
      return;
    }

    // Modo Leitura Direta
    if (!caliperState.solvedCurrent) {
      state.caliperStats.total++;
      if (dialOk) {
        state.caliperStats.correct++;
        state.caliperStats.streak++;
      } else {
        state.caliperStats.streak = 0;
      }
      caliperState.solvedCurrent = true;
      saveState();
      updateCaliperStatsUI();
    }

    if (dialOk) {
      fb.className = "feedback-banner ok";
      fb.innerHTML = `✅ <strong>Exato!</strong> Leitura = <strong>${fmt(target, 1)} mm</strong> (${turns} volta(s) no ponteiro vermelho = ${turns * 10} mm + ${fmt(rem, 1)} mm no ponteiro preto).`;
    } else {
      const offByTen = Math.abs(Math.abs(rawVal - target) - 10) <= 0.25;
      fb.className = "feedback-banner err";
      fb.innerHTML = `❌ <strong>Quase!</strong> O valor exato é <strong>${fmt(target, 1)} mm</strong> (${turns} volta(s) = ${turns * 10} mm + ${fmt(rem, 1)} mm).${
        offByTen ? " <em>Cuidado: você errou por 1 volta completa (10 mm) no ponteiro vermelho!</em>" : ""
      }`;
      document.getElementById("dialGuideArc").classList.remove("hidden");
    }
  }

  /* ========================================================================
     ABA 3: Estação Prática (ISAK)
     ======================================================================== */

  const stationState = {
    timerId: null,
    remainingSec: 300,
    running: false,
    started: false
  };

  function renderChecklist() {
    const container = document.getElementById("practicalChecklist");
    container.innerHTML = CHECKLIST_ITEMS.map(
      (text, idx) => `
        <label class="check-row" data-check-row="${idx}">
          <input type="checkbox" data-check-idx="${idx}" />
          <span>${escapeHtml(text)}</span>
        </label>
      `
    ).join("");

    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        cb.closest(".check-row").classList.toggle("checked", cb.checked);
        updateChecklistCounter();
      });
    });

    updateChecklistCounter();
    document.getElementById("stationsCompletedBadge").textContent =
      `Estações concluídas: ${state.stationsCompleted}`;
  }

  function updateChecklistCounter() {
    const boxes = document.querySelectorAll('#practicalChecklist input[type="checkbox"]');
    const done = Array.from(boxes).filter((b) => b.checked).length;
    const badge = document.getElementById("checklistProgress");
    badge.textContent = `${done} / ${boxes.length}`;
    badge.className = done === boxes.length ? "badge badge-emerald" : "badge";
  }

  function renderTimerDisplay() {
    const m = String(Math.floor(stationState.remainingSec / 60)).padStart(2, "0");
    const s = String(stationState.remainingSec % 60).padStart(2, "0");
    const disp = document.getElementById("timerDisplay");
    disp.textContent = `${m}:${s}`;
    disp.classList.remove("warning", "expired");
    if (stationState.remainingSec <= 0) disp.classList.add("expired");
    else if (stationState.remainingSec <= 60) disp.classList.add("warning");
  }

  function startTimerInterval() {
    clearInterval(stationState.timerId);
    stationState.running = true;
    const toggleBtn = document.getElementById("btnToggleTimer");
    toggleBtn.disabled = false;
    toggleBtn.textContent = "⏸ Pausar";

    stationState.timerId = setInterval(() => {
      stationState.remainingSec--;
      renderTimerDisplay();
      if (stationState.remainingSec <= 0) {
        clearInterval(stationState.timerId);
        stationState.running = false;
        toggleBtn.textContent = "▶ Reiniciar";
        playBeep();
        showToast("⏰ Tempo da estação esgotado!");
      }
    }, 1000);
  }

  function toggleStationTimer() {
    if (!stationState.started) return;
    const toggleBtn = document.getElementById("btnToggleTimer");

    if (stationState.remainingSec <= 0) {
      stationState.remainingSec = Number(document.getElementById("timerPreset").value) || 300;
      renderTimerDisplay();
      startTimerInterval();
      return;
    }

    if (stationState.running) {
      clearInterval(stationState.timerId);
      stationState.running = false;
      toggleBtn.textContent = "▶ Retomar";
    } else {
      startTimerInterval();
    }
  }

  function startPracticalStation() {
    const pool = window.NUTRIPREP_DEFAULT_DATA.practicalPool;
    const shuffled = pool.dobras.slice().sort(() => Math.random() - 0.5).slice(0, 4);
    const extra = pool.extras[Math.floor(Math.random() * pool.extras.length)];

    const listEl = document.getElementById("drawnMeasures");
    const dobrasHtml = shuffled
      .map(
        (d, i) => `
        <li class="measure-item">
          <div class="measure-head">
            <span class="measure-title">Dobra ${i + 1}: ${escapeHtml(d.name)}</span>
            <button type="button" class="btn btn-ghost btn-sm btn-reveal-item">Ver técnica</button>
          </div>
          <div class="measure-detail hidden">
            <strong>Sentido:</strong> ${escapeHtml(d.orientation)}<br/>
            <strong>Ponto anatômico:</strong> ${escapeHtml(d.landmark)}<br/>
            <strong>Dica ISAK:</strong> ${escapeHtml(d.tip)}
          </div>
        </li>
      `
      )
      .join("");

    const extraHtml = `
      <li class="measure-item extra">
        <div class="measure-head">
          <span class="measure-title">Extra: ${escapeHtml(extra.name)}</span>
          <button type="button" class="btn btn-ghost btn-sm btn-reveal-item">Ver técnica</button>
        </div>
        <div class="measure-detail hidden">${escapeHtml(extra.detail)}</div>
      </li>
    `;

    listEl.innerHTML = dobrasHtml + extraHtml;

    listEl.querySelectorAll(".btn-reveal-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const detail = btn.closest(".measure-item").querySelector(".measure-detail");
        const isHidden = detail.classList.toggle("hidden");
        btn.textContent = isHidden ? "Ver técnica" : "Ocultar";
      });
    });

    document.getElementById("btnRevealAll").classList.remove("hidden");

    // Reset checklist
    document.querySelectorAll('#practicalChecklist input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
      cb.closest(".check-row").classList.remove("checked");
    });
    updateChecklistCounter();

    // Start countdown
    stationState.started = true;
    stationState.remainingSec = Number(document.getElementById("timerPreset").value) || 300;
    renderTimerDisplay();
    startTimerInterval();
  }

  /* ========================================================================
     ABA 4: Conferência de Fórmulas
     ======================================================================== */

  function updatePetroskiLabels() {
    const sex = document.getElementById("calcSex").value;
    if (sex === "M") {
      document.getElementById("lblWeight").innerHTML = 'Peso (kg) <span class="field-hint">(opcional H)</span>';
      document.getElementById("lblHeight").innerHTML = 'Estatura (cm) <span class="field-hint">(opcional H)</span>';
      document.getElementById("lblDc1").textContent = "Subescapular (mm)";
      document.getElementById("lblDc2").textContent = "Tríceps (mm)";
      document.getElementById("lblDc3").textContent = "Suprailíaca (mm)";
      document.getElementById("lblDc4").textContent = "Panturrilha Medial (mm)";
    } else {
      document.getElementById("lblWeight").innerHTML = 'Peso (kg) <span class="field-hint">(obrigatório M)</span>';
      document.getElementById("lblHeight").innerHTML = 'Estatura (cm) <span class="field-hint">(obrigatório M)</span>';
      document.getElementById("lblDc1").textContent = "Axilar Média (mm)";
      document.getElementById("lblDc2").textContent = "Suprailíaca (mm)";
      document.getElementById("lblDc3").textContent = "Coxa Média (mm)";
      document.getElementById("lblDc4").textContent = "Panturrilha Medial (mm)";
    }
  }

  function calculatePetroski() {
    const sex = document.getElementById("calcSex").value;
    const age = parseFloat(document.getElementById("calcAge").value);
    const w = parseFloat(document.getElementById("calcWeight").value);
    const h = parseFloat(document.getElementById("calcHeight").value);
    const dcVals = ["dc1", "dc2", "dc3", "dc4"].map((id) => parseFloat(document.getElementById(id).value));
    const out = document.getElementById("petroskiResult");

    if (Number.isNaN(age) || age <= 0 || dcVals.some((v) => Number.isNaN(v) || v <= 0)) {
      out.innerHTML = `<span style="color: var(--danger-text);">Preencha a <strong>idade</strong> e todas as <strong>4 dobras cutâneas</strong> com valores positivos.</span>`;
      return;
    }

    if (sex === "F" && (Number.isNaN(w) || w <= 0 || Number.isNaN(h) || h <= 0)) {
      out.innerHTML = `<span style="color: var(--danger-text);">No protocolo <strong>Feminino de Petroski (1995)</strong>, <strong>Peso (kg)</strong> e <strong>Estatura (cm)</strong> entram na equação e são obrigatórios.</span>`;
      return;
    }

    const sum = dcVals.reduce((acc, v) => acc + v, 0);
    const dc =
      sex === "M"
        ? 1.10726863 - 0.00081201 * sum + 0.00000212 * (sum * sum) - 0.00041761 * age
        : 1.02902361 - 0.00067159 * sum + 0.00000242 * (sum * sum) - 0.00026073 * age - 0.00056009 * w + 0.00054649 * h;

    const gc = (4.95 / dc - 4.5) * 100;

    let extraComp = "";
    if (!Number.isNaN(w) && w > 0) {
      const fatKg = (w * gc) / 100;
      const leanKg = w - fatKg;
      extraComp = `<br/><strong>Massa Gorda:</strong> <span class="result-highlight">${fmt(fatKg, 2)} kg</span> &nbsp;|&nbsp; <strong>Massa Livre de Gordura:</strong> <span class="result-highlight">${fmt(leanKg, 2)} kg</span>`;
    }

    out.innerHTML = `
      <strong>Σ 4 Dobras:</strong> <span class="result-highlight">${fmt(sum, 1)} mm</span><br/>
      <strong>Densidade Corporal (Dc):</strong> <span class="result-highlight">${fmt(dc, 4)} g/cm³</span><br/>
      <strong>% Gordura Corporal (Siri):</strong> <span class="result-highlight">${fmt(gc, 2)}%</span>
      ${extraComp}
      <div class="step-note">Siri (1961): %GC = [(4,95 / ${fmt(dc, 4)}) − 4,50] × 100</div>
    `;
  }

  function calculateIndices() {
    const sex = document.getElementById("indicesSex").value;
    const cb = parseFloat(document.getElementById("cbVal").value);
    const pct = parseFloat(document.getElementById("pctVal").value);
    const cint = parseFloat(document.getElementById("cintVal").value);
    const quad = parseFloat(document.getElementById("quadVal").value);
    const out = document.getElementById("indicesResult");
    const blocks = [];

    if (!Number.isNaN(cb) && cb > 0 && !Number.isNaN(pct) && pct > 0) {
      const pctCm = pct / 10;
      const cmb = cb - Math.PI * pctCm;
      const amb = (cmb * cmb) / (4 * Math.PI);
      const correction = sex === "M" ? 10 : 6.5;
      const ambc = amb - correction;

      blocks.push(`
        <div>
          <strong>CMB:</strong> <span class="result-highlight">${fmt(cmb, 2)} cm</span> &nbsp;|&nbsp;
          <strong>AMB:</strong> <span class="result-highlight">${fmt(amb, 2)} cm²</span> &nbsp;|&nbsp;
          <strong>AMBc (${sex === "M" ? "H" : "M"}):</strong> <span class="result-highlight">${fmt(ambc, 2)} cm²</span>
          <div class="step-note">PCT = ${fmt(pct, 1)} mm = ${fmt(pctCm, 2)} cm • CMB = ${fmt(cb, 1)} − (π × ${fmt(pctCm, 2)}) • AMBc = AMB − ${fmt(correction, 1)}</div>
        </div>
      `);
    }

    if (!Number.isNaN(cint) && cint > 0 && !Number.isNaN(quad) && quad > 0) {
      const rcq = cint / quad;
      const threshold = sex === "M" ? 0.9 : 0.85;
      const highRisk = rcq >= threshold;
      blocks.push(`
        <div style="${blocks.length ? "margin-top: 0.7rem;" : ""}">
          <strong>RCQ:</strong> <span class="result-highlight">${fmt(rcq, 2)}</span>
          <span class="badge ${highRisk ? "badge-danger" : "badge-emerald"}" style="margin-left: 0.45rem;">
            ${highRisk ? "Risco metabólico aumentado (OMS)" : "Dentro da referência (OMS)"}
          </span>
        </div>
      `);
    }

    out.innerHTML =
      blocks.join("") ||
      `<span style="color: var(--danger-text);">Preencha <strong>CB + PCT</strong> e/ou <strong>Cintura + Quadril</strong> para calcular.</span>`;
  }

  function calculateImcAndLoss() {
    const w = parseFloat(document.getElementById("imcWeight").value);
    const hCm = parseFloat(document.getElementById("imcHeight").value);
    const group = document.getElementById("imcGroup").value;
    const usual = parseFloat(document.getElementById("usualWeight").value);
    const period = document.getElementById("lossPeriod").value;
    const out = document.getElementById("imcResult");
    const blocks = [];

    if (!Number.isNaN(w) && w > 0 && !Number.isNaN(hCm) && hCm > 0) {
      const hM = hCm / 100;
      const imc = w / (hM * hM);
      let label = "";
      let cls = "badge-emerald";

      if (group === "idoso") {
        if (imc < 22) {
          label = "Baixo peso (Lipschitz/SISVAN < 22)";
          cls = "badge-amber";
        } else if (imc <= 27) {
          label = "Eutrofia (Lipschitz/SISVAN 22–27)";
          cls = "badge-emerald";
        } else {
          label = "Excesso de peso (Lipschitz/SISVAN > 27)";
          cls = "badge-danger";
        }
      } else {
        if (imc < 18.5) {
          label = "Baixo peso (OMS < 18,5)";
          cls = "badge-amber";
        } else if (imc < 25) {
          label = "Eutrofia (OMS 18,5–24,9)";
          cls = "badge-emerald";
        } else if (imc < 30) {
          label = "Sobrepeso (OMS 25,0–29,9)";
          cls = "badge-amber";
        } else if (imc < 35) {
          label = "Obesidade Grau I (OMS 30,0–34,9)";
          cls = "badge-danger";
        } else if (imc < 40) {
          label = "Obesidade Grau II (OMS 35,0–39,9)";
          cls = "badge-danger";
        } else {
          label = "Obesidade Grau III (OMS ≥ 40,0)";
          cls = "badge-danger";
        }
      }

      blocks.push(`
        <div>
          <strong>IMC:</strong> <span class="result-highlight">${fmt(imc, 2)} kg/m²</span>
          <span class="badge ${cls}" style="margin-left: 0.45rem;">${label}</span>
          <div class="step-note">IMC = ${fmt(w, 1)} / (${fmt(hM, 2)})²</div>
        </div>
      `);
    }

    if (!Number.isNaN(w) && w > 0 && !Number.isNaN(usual) && usual > 0) {
      const pp = ((usual - w) / usual) * 100;
      const limits = {
        "1w": { sig: 1, sev: 2, label: "1 semana" },
        "1m": { sig: 5, sev: 5, label: "1 mês" },
        "3m": { sig: 7.5, sev: 7.5, label: "3 meses" },
        "6m": { sig: 10, sev: 10, label: "6 meses" }
      }[period];

      let ppText = "";
      let ppCls = "badge-emerald";
      if (pp <= 0) {
        ppText = "Sem perda ponderal (ganho ou manutenção)";
      } else if (pp > limits.sev) {
        ppText = `Perda GRAVE em ${limits.label} (> ${fmt(limits.sev, 1)}%)`;
        ppCls = "badge-danger";
      } else if (pp >= limits.sig) {
        ppText = `Perda SIGNIFICATIVA em ${limits.label}`;
        ppCls = "badge-amber";
      } else {
        ppText = `Perda leve (< ${fmt(limits.sig, 1)}% em ${limits.label})`;
      }

      blocks.push(`
        <div style="${blocks.length ? "margin-top: 0.7rem;" : ""}">
          <strong>% Perda de Peso (Blackburn):</strong> <span class="result-highlight">${fmt(pp, 2)}%</span>
          <span class="badge ${ppCls}" style="margin-left: 0.45rem;">${ppText}</span>
          <div class="step-note">%PP = [(${fmt(usual, 1)} − ${fmt(w, 1)}) / ${fmt(usual, 1)}] × 100</div>
        </div>
      `);
    }

    out.innerHTML =
      blocks.join("") ||
      `<span style="color: var(--danger-text);">Informe Peso Atual + Estatura (para IMC) e/ou Peso Usual (para %PP).</span>`;
  }

  /* ========================================================================
     ABA 5: Gerenciar, Importar & Exportar JSON
     ======================================================================== */

  function renderStats() {
    const keys = Object.keys(state.modules);
    const totalQ = keys.reduce((acc, k) => acc + state.modules[k].questions.length, 0);
    const totalAns = Object.keys(state.answers).length;
    document.getElementById("statModules").textContent = String(keys.length);
    document.getElementById("statQuestions").textContent = String(totalQ);
    document.getElementById("statAnswered").textContent = String(totalAns);
  }

  function importQuestions() {
    const targetId = document.getElementById("importTargetModule").value;
    const raw = document.getElementById("jsonInput").value.trim();
    const fb = document.getElementById("importFeedback");

    if (!raw) {
      fb.className = "feedback-banner err";
      fb.textContent = "Cole um array JSON válido antes de carregar.";
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("O JSON deve ser um array [ ... ] com pelo menos 1 questão.");
      }

      const validItems = parsed.map((item, idx) => {
        if (
          !item ||
          typeof item.q !== "string" ||
          !Array.isArray(item.options) ||
          item.options.length < 2 ||
          typeof item.answer !== "number" ||
          item.answer < 0 ||
          item.answer >= item.options.length
        ) {
          throw new Error(`Questão #${idx + 1} com campos inválidos (verifique q, options e answer).`);
        }
        return {
          id: item.id || `${targetId}-imp-${Date.now()}-${idx}`,
          topic: item.topic || "Tópico Importado",
          tag: item.tag || "Importada",
          q: item.q.trim(),
          options: item.options.map((o) => String(o)),
          answer: item.answer,
          explanation: item.explanation ? String(item.explanation) : "Sem comentário cadastrado."
        };
      });

      state.modules[targetId].questions = state.modules[targetId].questions.concat(validItems);
      saveState();
      populateModuleSelectors();
      renderStats();

      document.getElementById("jsonInput").value = "";
      fb.className = "feedback-banner ok";
      fb.textContent = `✅ ${validItems.length} questão(ões) adicionada(s) em "${state.modules[targetId].name}"!`;

      if (state.activeModule === targetId) {
        rebuildTopicFilter();
        renderQuestionView();
      }
      showToast(`${validItems.length} questões importadas!`);
    } catch (err) {
      fb.className = "feedback-banner err";
      fb.textContent = `❌ Erro ao importar JSON: ${err.message}`;
    }
  }

  function createCustomModule() {
    const nameInput = document.getElementById("newModuleName");
    const subInput = document.getElementById("newModuleSub");
    const name = nameInput.value.trim();
    const subtitle = subInput.value.trim();

    if (!name) {
      showToast("Informe o nome do novo módulo.");
      return;
    }

    let id = slugify(name);
    if (state.modules[id]) {
      id = `${id}_${Date.now()}`;
    }

    state.modules[id] = {
      id,
      name,
      subtitle: subtitle || "Módulo personalizado",
      questions: []
    };
    saveState();
    populateModuleSelectors();
    renderStats();
    document.getElementById("importTargetModule").value = id;

    nameInput.value = "";
    subInput.value = "";
    showToast(`Módulo "${name}" criado! Agora você pode importar questões para ele.`);
  }

  function copyPromptForAI() {
    const prompt = `A partir do conteúdo desta aula/prova de Nutrição (ENARE / Graduação), gere 5 questões de múltipla escolha (com pegadinhas clínicas ou cálculos em cascata quando aplicável) ESTRITAMENTE no formato JSON abaixo, sem texto fora do JSON:

[
  {
    "topic": "Nome do Tópico",
    "tag": "ENARE",
    "q": "Enunciado completo da questão...",
    "options": [
      "Texto da alternativa A",
      "Texto da alternativa B",
      "Texto da alternativa C",
      "Texto da alternativa D"
    ],
    "answer": 0,
    "explanation": "Gabarito comentado explicando por que a correta está certa e o erro das demais."
  }
]`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(
        () => showToast("Prompt copiado! Cole no Gemini ou NotebookLM."),
        () => fallbackCopy(prompt)
      );
    } else {
      fallbackCopy(prompt);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Prompt copiado! Cole no Gemini ou NotebookLM.");
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nutriprep360-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Backup JSON exportado!");
  }

  function factoryReset() {
    if (!confirm("Isso vai restaurar os módulos padrão e apagar questões importadas e respostas salvas. Continuar?")) {
      return;
    }
    localStorage.removeItem(STORAGE_KEY);
    state = loadState();
    applyTheme(state.theme);
    qState.topicFilter = "ALL";
    qState.reviewWrongOnly = false;
    qState.shuffledOrder = null;
    qState.index = 0;
    populateModuleSelectors();
    rebuildTopicFilter();
    renderQuestionView();
    updateCaliperStatsUI();
    renderChecklist();
    renderStats();
    showToast("Plataforma restaurada ao padrão original.");
  }

  /* ========================================================================
     Inicialização & Listeners
     ======================================================================== */

  function bindEvents() {
    // Theme toggle
    document.getElementById("themeToggle").addEventListener("click", toggleTheme);

    // Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab));
    });

    // Questions Toolbar
    document.getElementById("topicFilter").addEventListener("change", (e) => {
      qState.topicFilter = e.target.value;
      qState.index = 0;
      renderQuestionView();
    });

    document.getElementById("btnReviewWrong").addEventListener("click", () => {
      qState.reviewWrongOnly = !qState.reviewWrongOnly;
      qState.index = 0;
      renderQuestionView();
    });

    document.getElementById("btnShuffle").addEventListener("click", () => {
      const ids = getActiveModule().questions.map((q) => q.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      qState.shuffledOrder = ids;
      qState.index = 0;
      renderQuestionView();
      showToast("Ordem das questões embaralhada!");
    });

    document.getElementById("btnResetModule").addEventListener("click", () => {
      const mod = getActiveModule();
      if (!confirm(`Zerar todas as respostas salvas do módulo "${mod.name}"?`)) return;
      mod.questions.forEach((q) => delete state.answers[q.id]);
      qState.reviewWrongOnly = false;
      qState.index = 0;
      saveState();
      renderQuestionView();
      showToast("Respostas do módulo reiniciadas.");
    });

    // Adipometer
    document.getElementById("caliperMode").addEventListener("change", generateCaliper);
    document.getElementById("btnCheckCaliper").addEventListener("click", checkCaliper);
    document.getElementById("btnNewCaliper").addEventListener("click", generateCaliper);
    document.getElementById("btnToggleDialHint").addEventListener("click", toggleDialHint);
    ["caliperInput", "cascadeCmbInput"].forEach((id) => {
      document.getElementById(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter") checkCaliper();
      });
    });

    // Practical Station
    document.getElementById("btnStartStation").addEventListener("click", startPracticalStation);
    document.getElementById("btnToggleTimer").addEventListener("click", toggleStationTimer);
    document.getElementById("timerPreset").addEventListener("change", () => {
      if (!stationState.running) {
        stationState.remainingSec = Number(document.getElementById("timerPreset").value) || 300;
        renderTimerDisplay();
      }
    });
    document.getElementById("btnRevealAll").addEventListener("click", () => {
      const details = document.querySelectorAll("#drawnMeasures .measure-detail");
      const anyHidden = Array.from(details).some((d) => d.classList.contains("hidden"));
      details.forEach((d) => d.classList.toggle("hidden", !anyHidden));
      document.querySelectorAll("#drawnMeasures .btn-reveal-item").forEach((b) => {
        b.textContent = anyHidden ? "Ocultar" : "Ver técnica";
      });
    });
    document.getElementById("btnCompleteStation").addEventListener("click", () => {
      state.stationsCompleted++;
      saveState();
      document.getElementById("stationsCompletedBadge").textContent =
        `Estações concluídas: ${state.stationsCompleted}`;
      showToast(`Estação prática #${state.stationsCompleted} registrada!`);
    });

    // Calculators
    document.getElementById("calcSex").addEventListener("change", updatePetroskiLabels);
    document.getElementById("btnCalcPetroski").addEventListener("click", calculatePetroski);
    document.getElementById("btnCalcIndices").addEventListener("click", calculateIndices);
    document.getElementById("btnCalcImc").addEventListener("click", calculateImcAndLoss);

    // Importer & Manager
    document.getElementById("btnImportJson").addEventListener("click", importQuestions);
    document.getElementById("btnCopyPrompt").addEventListener("click", copyPromptForAI);
    document.getElementById("btnCreateModule").addEventListener("click", createCustomModule);
    document.getElementById("btnExportBackup").addEventListener("click", exportBackup);
    document.getElementById("btnFactoryReset").addEventListener("click", factoryReset);

    // Keyboard shortcuts on Questions tab
    document.addEventListener("keydown", (e) => {
      if (state.activeTab !== "questoes") return;
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

      const list = getFilteredQuestions();
      if (list.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === "arrowright") {
        qState.index = (qState.index + 1) % list.length;
        renderQuestionView();
      } else if (key === "arrowleft") {
        qState.index = (qState.index - 1 + list.length) % list.length;
        renderQuestionView();
      } else {
        const idxMap = { a: 0, b: 1, c: 2, d: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
        if (idxMap[key] !== undefined) {
          const item = list[qState.index];
          if (idxMap[key] < item.options.length) {
            answerCurrentQuestion(item, idxMap[key]);
          }
        }
      }
    });
  }

  function init() {
    applyTheme(state.theme);
    populateModuleSelectors();
    rebuildTopicFilter();
    bindEvents();
    updatePetroskiLabels();
    initDialSvg();
    renderChecklist();
    renderTimerDisplay();
    renderQuestionView();
    renderStats();
    setTab(state.activeTab);
  }

  init();
})();
