const API_KEY = "YOUR_GEMINI_API_KEY_HERE";
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
    }
    return true;
});

async function handleGeminiChat(tabId, userMessage, mode) {
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return;

        let pageText = "";
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => document.body ? document.body.innerText : ""
            });
            pageText = results[0].result || "";
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
    activeMCQTabs[tabId] = true;
    pushAndNotifyAI(tabId, `🚀 Automated MCQ Solver loop initiated.`);

    while (activeMCQTabs[tabId]) {
        try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) { delete activeMCQTabs[tabId]; break; }

            let injectionResults = await chrome.scripting.executeScript({
                target: { tabId: tabId },
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
            });

            if (!injectionResults || !injectionResults[0] || !activeMCQTabs[tabId]) break;
            const pageData = injectionResults[0].result;

            const prompt = `Analyze this page text, find the question, and solve it. Conclude your answer line with: "FINAL_CHOICE: [A/B/C/D]".\n\nPage Content:\n${pageData.bodyText}`;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            const data = await response.json();
            if (!activeMCQTabs[tabId]) break;

            const answerText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            pushAndNotifyAI(tabId, answerText);

            const match = answerText.match(/FINAL_CHOICE:\s*([A-Da-d])/i);
            const chosenLetter = match ? match[1].toUpperCase() : null;

            if (chosenLetter && activeMCQTabs[tabId]) {
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    args: [chosenLetter, pageData.isLastQuestion],
                    func: (targetLetter, lastQFlag) => {
                        let clicked = false;
                        const allElements = document.querySelectorAll('label, button, input, div, span, [role="radio"], [role="checkbox"], li');
                        for (let el of allElements) {
                            const text = el.innerText ? el.innerText.trim() : "";
                            const aria = el.getAttribute('aria-label') || "";
                            if (new RegExp(`^(\\b|\\()\\s*${targetLetter}[\\.\\)\\-]`, 'i').test(text) || 
                                new RegExp(`^(\\b|\\()\\s*${targetLetter}[\\.\\)\\-]`, 'i').test(aria)) {
                                el.click(); clicked = true; break;
                            }
                        }
                        if (!clicked) {
                            const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
                            const indexMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
                            if (inputs[indexMap[targetLetter]]) { inputs[indexMap[targetLetter]].click(); clicked = true; }
                        }
                        if (!lastQFlag) {
                            setTimeout(() => {
                                const actionButtons = document.querySelectorAll('button, input[type="submit"], a, [role="button"]');
                                for (let btn of actionButtons) {
                                    const bText = (btn.innerText || btn.value || btn.getAttribute('aria-label') || "").toLowerCase();
                                    if (bText.includes('next') || bText.includes('continue') || bText.includes('proceed') || bText.includes('save')) {
                                        if (btn.offsetParent !== null) { btn.click(); break; }
                                    }
                                }
                            }, 1200);
                        }
                    }
                });
            }

            if (pageData.isLastQuestion) {
                pushAndNotifyAI(tabId, `🏁 Final MCQ boundary reached. Halting loop.`);
                delete activeMCQTabs[tabId];
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (err) {
            break;
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