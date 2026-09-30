const API_KEY = "[ENCRYPTION_KEY]";
const MODEL = "gemini-3.1-flash-lite";

let tabConversations = {}; 
let activeMCQTabs = {};    

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_CHAT_HISTORY") {
        const tabId = request.tabId;
        sendResponse({ history: tabConversations[tabId] || [] });

    } else if (request.action === "SEND_CHAT_MESSAGE") {
        const tabId = request.tabId;
        const userMsg = request.message;
        const mode = request.mode || "general";

        if (!tabConversations[tabId]) tabConversations[tabId] = [];
        tabConversations[tabId].push({ sender: "User", text: userMsg });

        handleGeminiChat(tabId, userMsg, mode);
        sendResponse({ status: "processing" });

    } else if (request.action === "START_MCQ_LOOP") {
        const tabId = request.tabId;
        if (!activeMCQTabs[tabId]) {
            runMCQLoop(tabId);
        } else {
            pushAndNotifyAI(tabId, "⚠️ MCQ Automation loop is already active.");
        }
        sendResponse({ status: "started" });

    } else if (request.action === "STOP_MCQ_LOOP") {
        const tabId = request.tabId;
        if (activeMCQTabs[tabId]) {
            delete activeMCQTabs[tabId];
            pushAndNotifyAI(tabId, "⏹ MCQ Automation terminated manually.");
        }
        sendResponse({ status: "stopped" });

    } else if (request.action === "INJECT_CODE_TO_EDITOR") {
        const tabId = request.tabId;
        const code = request.code;
        injectCodeToTabEditor(tabId, code).then((success) => {
            sendResponse({ success });
        }).catch(() => {
            sendResponse({ success: false });
        });
        return true;
    }
    return true;
});

async function injectCodeToTabEditor(tabId, code) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            args: [code],
            func: (codeToInject) => {
                let success = false;

                // 1. Monaco Editor API (VS Code / ByteXL)
                try {
                    if (window.monaco && window.monaco.editor) {
                        const editors = window.monaco.editor.getEditors();
                        if (editors && editors.length > 0) {
                            const activeEditor = editors.find(e => (typeof e.hasWidgetFocus === 'function' && e.hasWidgetFocus())) || editors[0];
                            if (activeEditor && activeEditor.setValue) {
                                activeEditor.setValue(codeToInject);
                                return true;
                            }
                        }
                    }
                } catch (e) {}

                // 2. CodeMirror 5 / 6 API
                try {
                    const cmEl = document.querySelector('.CodeMirror');
                    if (cmEl && cmEl.CodeMirror && typeof cmEl.CodeMirror.setValue === 'function') {
                        cmEl.CodeMirror.setValue(codeToInject);
                        return true;
                    }
                } catch (e) {}

                // 3. ACE Editor API
                try {
                    const aceEl = document.querySelector('.ace_editor');
                    if (aceEl && window.ace && typeof window.ace.edit === 'function') {
                        const editor = window.ace.edit(aceEl);
                        if (editor && typeof editor.setValue === 'function') {
                            editor.setValue(codeToInject, -1);
                            return true;
                        }
                    }
                } catch (e) {}

                // 4. Fallback: Target active element or textareas / inputareas
                try {
                    let targetEl = document.activeElement;
                    if (!targetEl || targetEl === document.body || targetEl.tagName === 'BODY') {
                        targetEl = document.querySelector('.monaco-editor textarea, textarea.inputarea, .CodeMirror textarea, textarea, [contenteditable="true"]');
                    }

                    if (targetEl) {
                        targetEl.focus();
                        if (targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'INPUT') {
                            targetEl.select();
                            const execSuccess = document.execCommand('insertText', false, codeToInject);
                            if (!execSuccess || targetEl.value !== codeToInject) {
                                targetEl.value = codeToInject;
                                targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                                targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                            return true;
                        } else if (targetEl.isContentEditable) {
                            targetEl.innerText = codeToInject;
                            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                            return true;
                        }
                    }
                } catch (e) {}

                return false;
            }
        });

        const isAnyFrameSuccess = (results || []).some(r => r.result === true);
        return isAnyFrameSuccess;
    } catch (err) {
        console.error("[INJECT_CODE_TO_EDITOR Error]:", err);
        return false;
    }
}

async function handleGeminiChat(tabId, userMessage, mode) {
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return;

        let pageText = "";
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: () => document.body ? document.body.innerText : ""
            });
            pageText = (results || []).map(r => r.result).filter(Boolean).join("\n\n");
        } catch (e) {}

        let systemInstruction = "You are a helpful AI tab assistant.";
        if (mode === "solve") {
            systemInstruction = "You are an expert programming agent. Write a precise solution or code query for the problem found on the page. Use markdown code blocks.";
        } else if (mode === "explain") {
            systemInstruction = "Analyze the code or content on this web page and provide a concise breakdown summary.";
        }

        const prompt = `${systemInstruction}\n\nWeb Page Context:\n${pageText}\n\nUser Request:\n${userMessage}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();

        if (data.error) {
            pushAndNotifyAI(tabId, `API Error: ${data.error.message}`);
            return;
        }

        const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
        pushAndNotifyAI(tabId, aiReply);
    } catch (err) {
        pushAndNotifyAI(tabId, `Connection error: ${err.message}`);
    }
}

async function runMCQLoop(tabId) {
    if (activeMCQTabs[tabId]) return;
    activeMCQTabs[tabId] = true;
    pushAndNotifyAI(tabId, `🚀 MCQ Automation loop active for Tab: ${tabId}`);

    let lastQuestionText = ""; 
    let stuckCounter = 0;

    while (activeMCQTabs[tabId]) {
        try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab || !activeMCQTabs[tabId]) { delete activeMCQTabs[tabId]; break; }

            // 1. Scrape current page context across all frames (including embedded assessment iframes like oc-challenge)
            let injectionResults = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: () => {
                    const bodyText = document.body ? document.body.innerText : "";
                    let isLastQuestion = false;
                    const buttons = document.querySelectorAll('button, input[type="submit"], a, [role="button"]');
                    for (let btn of buttons) {
                        const bText = (btn.innerText || btn.value || btn.getAttribute('aria-label') || "").toLowerCase();
                        if (bText.includes('submit test') || bText.includes('finish test') || bText.includes('submit quiz') || (bText === 'finish')) {
                            if (btn.offsetParent !== null) { isLastQuestion = true; break; }
                        }
                    }
                    return { bodyText, isLastQuestion };
                }
            }).catch(() => null);

            if (!injectionResults || injectionResults.length === 0 || !activeMCQTabs[tabId]) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            const combinedBodyText = injectionResults.map(r => r.result?.bodyText || "").filter(Boolean).join("\n\n");
            const isLastQ = injectionResults.some(r => r.result?.isLastQuestion);
            const pageData = { bodyText: combinedBodyText, isLastQuestion: isLastQ };

            if (pageData.bodyText === lastQuestionText) {
                stuckCounter++;
                if (stuckCounter < 4) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                } else {
                    stuckCounter = 0;
                    lastQuestionText = ""; // Force reset if stuck
                }
            } else {
                stuckCounter = 0;
            }
            // If text extraction fails or text is too short (e.g. canvas, image, iframe, pdf player)
            let isVisionFallback = false;
            let dataUrl = null;
            if (!pageData.bodyText || pageData.bodyText.trim().length < 20) {
                isVisionFallback = true;
                pushAndNotifyAI(tabId, `📷 Text not detected in DOM (Canvas/Image/PDF detected). Activating Vision AI...`);
                try {
                    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                } catch (e) {
                    pushAndNotifyAI(tabId, `⚠️ Failed to capture tab screenshot for vision fallback.`);
                }
            }

            pushAndNotifyAI(tabId, isVisionFallback ? `👁️ Analyzing question via Vision AI...` : `🔍 Analyzing question...`);

            let promptPayload;
            if (isVisionFallback && dataUrl) {
                const base64Data = dataUrl.replace(/^data:image\/(png|jpeg);base64,/, "");
                promptPayload = {
                    contents: [{
                        parts: [
                            {
                                text: `Look at this screenshot of a test/quiz web page where text could not be extracted directly from DOM.
Isolate the multiple choice question and choices shown on screen.
Identify the correct option (A, B, C, D) and specify normalized bounding box coordinates (0 to 1000 scale, where top-left is 0,0 and bottom-right is 1000,1000) for the target option click location (e.g. the radio button, option box, or letter target).

Conclude your response strictly with these lines at the end:
FINAL_CHOICE: [Letter A/B/C/D]
OPTION_TEXT: [Short description or text of chosen option]
CLICK_NORM_X: [Integer 0 to 1000]
CLICK_NORM_Y: [Integer 0 to 1000]`
                            },
                            {
                                inline_data: {
                                    mime_type: "image/png",
                                    data: base64Data
                                }
                            }
                        ]
                    }]
                };
            } else {
                promptPayload = {
                    contents: [{
                        parts: [{
                            text: `Analyze this page text, isolate the question, and solve it. 
Conclude your response strictly with these two lines at the end:
FINAL_CHOICE: [Letter A/B/C/D]
OPTION_TEXT: [Exact initial text of the correct option]

Page Content:
${pageData.bodyText}`
                        }]
                    }]
                };
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(promptPayload)
            }).catch(() => null);

            if (!response || !activeMCQTabs[tabId]) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            const data = await response.json();
            const answerText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            pushAndNotifyAI(tabId, answerText);

            // 3. Extract Choice and optional Vision Pixel Click Coordinates
            const letterMatch = answerText.match(/(?:FINAL_CHOICE|ANSWER)[:\s]*\[?\s*([A-Da-d])\s*\]?/i) || answerText.match(/\b([A-D])\b(?![\s\S]*\b[A-D]\b)/i);
            const chosenLetter = letterMatch ? letterMatch[1].toUpperCase() : "A";

            const textMatch = answerText.match(/OPTION_TEXT:\s*\[?\s*(.*?)\s*\]?$/m);
            const chosenTextSnippet = textMatch ? textMatch[1].trim() : "";

            const normXMatch = answerText.match(/CLICK_NORM_X:\s*\[?\s*(\d+)\s*\]?/i);
            const normYMatch = answerText.match(/CLICK_NORM_Y:\s*\[?\s*(\d+)\s*\]?/i);
            const normX = normXMatch ? parseInt(normXMatch[1], 10) : null;
            const normY = normYMatch ? parseInt(normYMatch[1], 10) : null;

            // 4. FORCE EXECUTION: Immediately inject script to mark the answer on the webpage or perform pixel click
            await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                args: [chosenLetter, chosenTextSnippet, pageData.isLastQuestion, normX, normY],
                func: (targetLetter, textSnippet, lastQFlag, clickNormX, clickNormY) => {
                    let clicked = false;
                    const upper = targetLetter.toUpperCase();
                    console.log(`[MCQ Solver] Attempting option selection for: ${upper}`);

                    // Strategy 0: Vision-based Normalized Pixel Click Fallback
                    if (clickNormX !== null && clickNormY !== null && clickNormX >= 0 && clickNormX <= 1000 && clickNormY >= 0 && clickNormY <= 1000) {
                        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
                        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
                        const pageX = (clickNormX / 1000) * viewportWidth;
                        const pageY = (clickNormY / 1000) * viewportHeight;

                        console.log(`[MCQ Vision Click] Target normalized (${clickNormX}, ${clickNormY}) -> Viewport pixels (${pageX}px, ${pageY}px)`);

                        const elAtPoint = document.elementFromPoint(pageX, pageY);
                        if (elAtPoint) {
                            const clickEventInit = {
                                clientX: pageX,
                                clientY: pageY,
                                pageX: pageX,
                                pageY: pageY,
                                bubbles: true,
                                cancelable: true,
                                view: window
                            };

                            elAtPoint.dispatchEvent(new MouseEvent('pointerdown', clickEventInit));
                            elAtPoint.dispatchEvent(new MouseEvent('mousedown', clickEventInit));
                            elAtPoint.dispatchEvent(new MouseEvent('pointerup', clickEventInit));
                            elAtPoint.dispatchEvent(new MouseEvent('mouseup', clickEventInit));
                            elAtPoint.dispatchEvent(new MouseEvent('click', clickEventInit));
                            
                            if (typeof elAtPoint.click === 'function') {
                                elAtPoint.click();
                            }
                            clicked = true;
                        }
                    }

                    // Strategy 1: Match by input index (radio / checkbox)
                    if (!clicked) {
                        const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
                        if (inputs.length > 0) {
                            const indexMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
                            const targetIndex = indexMap[upper] !== undefined ? indexMap[upper] : 0;
                            
                            if (inputs[targetIndex]) {
                                const inp = inputs[targetIndex];
                                inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                inp.click();
                                inp.checked = true;
                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                
                                const parentLabel = inp.closest('label') || inp.parentElement;
                                if (parentLabel) parentLabel.click();
                                clicked = true;
                            }
                        }
                    }

                    // Strategy 2: Match by Text Snippet
                    if (!clicked && textSnippet && textSnippet.length > 3) {
                        const cleanSnippet = textSnippet.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20);
                        const candidates = document.querySelectorAll('label, div, span, button, a, [role="radio"], [role="option"], li');
                        
                        for (let el of candidates) {
                            const elText = (el.innerText || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                            if (el.innerText && el.innerText.length < 300 && elText.includes(cleanSnippet)) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                clicked = true;
                                break;
                            }
                        }
                    }

                    // Strategy 3: Match by Letter Prefix (A., B., C., D.)
                    if (!clicked) {
                        const candidates = document.querySelectorAll('label, div, span, button, a, [role="radio"], [role="option"], li');
                        for (let el of candidates) {
                            const text = (el.innerText || "").trim();
                            const aria = el.getAttribute('aria-label') || "";
                            const patterns = [
                                new RegExp(`^\\(?\\s*${upper}[\\.\\)\\-]\\s`, 'i'),
                                new RegExp(`^${upper}$`, 'i')
                            ];

                            if (patterns.some(p => p.test(text) || p.test(aria))) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                clicked = true;
                                break;
                            }
                        }
                    }

                    // Auto-advance to next question if enabled and clicked
                    if (!lastQFlag && clicked) {
                        setTimeout(() => {
                            const actionButtons = document.querySelectorAll('button, input[type="submit"], a, [role="button"]');
                            for (let btn of actionButtons) {
                                const bText = (btn.innerText || btn.value || btn.getAttribute('aria-label') || "").toLowerCase();
                                if (bText.includes('next') || bText.includes('continue') || bText.includes('proceed') || bText.includes('save')) {
                                    if (btn.offsetParent !== null) { btn.click(); break; }
                                }
                            }
                        }, 800);
                    }

                    return clicked;
                }
            }).catch(err => console.error("[MCQ Script Execution Error]:", err));

            if (pageData.isLastQuestion) {
                pushAndNotifyAI(tabId, `🏁 Final MCQ boundary reached. Halting loop.`);
                delete activeMCQTabs[tabId];
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    delete activeMCQTabs[tabId];
    pushAndNotifyAI(tabId, `🛑 Automation loop stopped.`);
}




function pushAndNotifyAI(tabId, text) {
    if (!tabConversations[tabId]) tabConversations[tabId] = [];
    tabConversations[tabId].push({ sender: "AI", text: text });
    chrome.runtime.sendMessage({ action: "NEW_CHAT_MESSAGE", tabId, sender: "AI", text: text }).catch(() => {});
}