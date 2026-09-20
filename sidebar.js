const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const tabInfo = document.getElementById('tab-info');
const taskMode = document.getElementById('taskMode');

const chatFooter = document.getElementById('chatFooter');
const mcqFooter = document.getElementById('mcqFooter');
const startAutoBtn = document.getElementById('startAutoBtn');
const stopAutoBtn = document.getElementById('stopAutoBtn');

let currentTabId = null;

async function updateActiveTabContext() {
    try {
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id !== currentTabId) {
            currentTabId = tab.id;
            tabInfo.innerText = `ID: ${currentTabId}`;
            loadTabHistory();
        }
    } catch (e) {}
}

setInterval(updateActiveTabContext, 1000);
updateActiveTabContext();

taskMode.addEventListener('change', () => {
    if (taskMode.value === 'mcq') {
        chatFooter.classList.add('hidden');
        mcqFooter.classList.remove('hidden');
    } else {
        chatFooter.classList.remove('hidden');
        mcqFooter.classList.add('hidden');
    }
});

function loadTabHistory() {
    chatContainer.innerHTML = "";
    chrome.runtime.sendMessage({ action: "GET_CHAT_HISTORY", tabId: currentTabId }, (response) => {
        if (response && response.history) {
            if (response.history.length === 0) {
                appendMessage("AI", "SYS_READY // Tab-aware Gemini Copilot online. Switch task mode or query below.");
            } else {
                response.history.forEach(msg => {
                    appendMessage(msg.sender, msg.text, false);
                });
            }
        }
    });
}

function sendMessage() {
    const text = userInput.value.trim();
    if (!text || !currentTabId) return;

    appendMessage("User", text);
    userInput.value = "";
    userInput.style.height = "18px";

    chrome.runtime.sendMessage({
        action: "SEND_CHAT_MESSAGE",
        tabId: currentTabId,
        message: text,
        mode: taskMode.value
    });
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

userInput.addEventListener('input', function() {
    this.style.height = '18px';
    this.style.height = (this.scrollHeight - 6) + 'px';
});

startAutoBtn.addEventListener('click', () => {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({ action: "START_MCQ_LOOP", tabId: currentTabId });
});

stopAutoBtn.addEventListener('click', () => {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({ action: "STOP_MCQ_LOOP", tabId: currentTabId });
});

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "NEW_CHAT_MESSAGE" && request.tabId === currentTabId) {
        appendMessage(request.sender, request.text);
    }
});

function appendMessage(sender, text, scrollToBottom = true) {
    const div = document.createElement('div');
    div.className = `message ${sender.toLowerCase()}`;
    
    if (sender === "AI") {
        div.innerHTML = formatMarkdownCodeBlocks(text);
    } else {
        div.innerText = text;
    }

    chatContainer.appendChild(div);
    if (scrollToBottom) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

function formatMarkdownCodeBlocks(text) {
    let formatted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    formatted = formatted.replace(/```([a-zA-Z]*)\s*([\s\S]*?)```/g, (match, lang, code) => {
        const cleanCode = code.trim();
        const displayLang = lang ? lang.toUpperCase() : "CODE";
        const encodedCode = encodeURIComponent(cleanCode);
        return `
            <div class="code-block-wrapper">
                <div class="code-header">
                    <span>${displayLang}</span>
                    <button class="copy-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodedCode}'));this.innerText='COPIED';setTimeout(()=>this.innerText='COPY', 1500);">COPY</button>
                </div>
                <pre><code>${cleanCode}</code></pre>
            </div>
        `;
    });

    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/^- (.*)$/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    formatted = formatted.replace(/\n/g, '<br>');

    return formatted;
}