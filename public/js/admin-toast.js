
// Admin Toast Notification System
// Automatically replaces browser alerts with aesthetic toasts
// Also provides showConfirm() for aesthetic confirmation modals

(function() {
    // 1. Inject CSS
    const style = document.createElement('style');
    style.textContent = `
        /* Toast CSS */
        #toast-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            pointer-events: none;
        }
        .toast-notification {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-left: 4px solid #3498db;
            box-shadow: 0 4px 15px rgba(0,0,0,0.15);
            border-radius: 4px;
            padding: 15px 20px;
            margin-bottom: 10px;
            min-width: 280px;
            max-width: 400px;
            display: flex;
            align-items: center;
            gap: 12px;
            transform: translateX(120%);
            transition: transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
            pointer-events: auto;
            font-family: 'Inter', sans-serif;
            font-size: 14px;
            color: #2c3e50;
        }
        .toast-notification.show {
            transform: translateX(0);
        }
        .toast-notification.success { border-left-color: #2ecc71; }
        .toast-notification.error { border-left-color: #e74c3c; }
        .toast-notification.warning { border-left-color: #f1c40f; }
        
        .toast-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .toast-success .toast-icon { color: #2ecc71; background: rgba(46, 204, 113, 0.1); }
        .toast-error .toast-icon { color: #e74c3c; background: rgba(231, 76, 60, 0.1); }
        .toast-warning .toast-icon { color: #f1c40f; background: rgba(241, 196, 15, 0.1); }
        .toast-info .toast-icon { color: #3498db; background: rgba(52, 152, 219, 0.1); }

        /* Confirm Modal CSS */
        .custom-confirm-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 10001;
            display: flex; align-items: center; justify-content: center;
            opacity: 0; visibility: hidden; transition: 0.2s;
            backdrop-filter: blur(3px);
        }
        .custom-confirm-overlay.show { opacity: 1; visibility: visible; }
        .custom-confirm-box {
            background: white; width: 90%; max-width: 400px;
            padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transform: scale(0.95); transition: 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            text-align: center;
            display: flex; flex-direction: column; align-items: center;
        }
        .custom-confirm-overlay.show .custom-confirm-box { transform: scale(1); }
        .confirm-icon-wrapper { 
            width: 70px; height: 70px; background: #fff9c4; border-radius: 50%; 
            color: #fbc02d; display: flex; align-items: center; justify-content: center;
            margin-bottom: 20px;
        }
        .confirm-title { font-size: 1.4rem; font-weight: 800; color: #333; margin-bottom: 10px; letter-spacing: -0.5px; }
        .confirm-message { color: #666; margin-bottom: 30px; line-height: 1.5; font-size: 1rem; }
        .confirm-actions { display: flex; gap: 12px; width: 100%; justify-content: center; }
        .confirm-btn { 
            padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; 
            font-weight: 600; font-size: 1rem; transition: 0.2s; flex: 1; max-width: 140px;
        }
        .confirm-btn-cancel { background: #f1f2f6; color: #7f8c8d; }
        .confirm-btn-cancel:hover { background: #e2e6ea; color: #2c3e50; }
        .confirm-btn-ok { background: #3498db; color: white; }
        .confirm-btn-ok:hover { background: #2980b9; box-shadow: 0 4px 10px rgba(52, 152, 219, 0.3); }
        .confirm-btn-danger { background: #e74c3c; color: white; }
        .confirm-btn-danger:hover { background: #c0392b; box-shadow: 0 4px 10px rgba(231, 76, 60, 0.3); }
        
        .confirm-input {
            width: 100%;
            padding: 12px;
            margin-bottom: 20px;
            border: 2px solid #dfe6e9;
            border-radius: 8px;
            font-size: 1rem;
            outline: none;
            transition: 0.2s;
            display: none;
        }
        .confirm-input:focus {
            border-color: #3498db;
        }

        /* Mobile Optimizations */
        @media (max-width: 480px) {
            .custom-confirm-box {
                width: 75%;
                padding: 15px;
            }
            .confirm-icon-wrapper {
                width: 40px;
                height: 40px;
                margin-bottom: 10px;
            }
            .confirm-icon-wrapper svg {
                width: 20px;
                height: 20px;
            }
            .confirm-title {
                font-size: 1.1rem;
                margin-bottom: 5px;
            }
            .confirm-message {
                font-size: 0.85rem;
                margin-bottom: 15px;
            }
            .confirm-btn {
                padding: 8px 10px;
                font-size: 0.8rem;
            }
            .confirm-input {
                width: 90%;
                padding: 8px;
                font-size: 0.9rem;
                margin-bottom: 15px;
            }
            
            /* Toasts on mobile */
            #toast-container {
                top: 10px;
                right: 10px;
                left: 10px;
                width: auto;
            }
            .toast-notification {
                min-width: auto;
                width: 100%;
                margin-bottom: 8px;
                padding: 10px 12px;
            }
        }
    `;
    document.head.appendChild(style);

    // 2. Create Toast Container
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    // 3. Create Confirm Modal Elements
    const confirmOverlay = document.createElement('div');
    confirmOverlay.className = 'custom-confirm-overlay';
    confirmOverlay.innerHTML = `
        <div class="custom-confirm-box">
            <div class="confirm-icon-wrapper">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            </div>
            <div class="confirm-title" id="confirm-title">WARNING</div>
            <div class="confirm-message" id="confirm-text">Are you sure you want to proceed?</div>
            <input type="text" id="confirm-input" class="confirm-input" placeholder="">
            <div class="confirm-actions">
                <button class="confirm-btn confirm-btn-cancel" id="confirm-cancel">Cancel</button>
                <button class="confirm-btn confirm-btn-ok" id="confirm-ok">Yes, Proceed</button>
            </div>
        </div>
    `;
    document.body.appendChild(confirmOverlay);

    // 4. Helper Icons
    const icons = {
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
    };

    // 5. Show Toast Function
    window.showToast = function(message, type = null) {
        if (!type) {
            const lowerMsg = String(message).toLowerCase();
            if (lowerMsg.includes('success') || lowerMsg.includes('saved') || lowerMsg.includes('updated') || lowerMsg.includes('deleted') || lowerMsg.includes('complete') || lowerMsg.includes('activated') || lowerMsg.includes('joined')) {
                type = 'success';
            } else if (lowerMsg.includes('fail') || lowerMsg.includes('error') || lowerMsg.includes('wrong') || lowerMsg.includes('denied') || lowerMsg.includes('mismatch')) {
                type = 'error';
            } else if (lowerMsg.includes('warning') || lowerMsg.includes('required') || lowerMsg.includes('invalid') || lowerMsg.includes('please')) {
                type = 'warning';
            } else {
                type = 'info';
            }
        }

        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || icons.info}</div>
            <div class="toast-message">${message}</div>
        `;

        const container = document.getElementById('toast-container');
        if (container) {
            container.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
            }, 3500);
        }
    };

    // 6. Show Confirm Function
    window.showConfirm = function(message, isDangerous = false, title = 'WARNING') {
        return new Promise((resolve) => {
            const titleEl = document.getElementById('confirm-title');
            const textEl = document.getElementById('confirm-text');
            const inputEl = document.getElementById('confirm-input');
            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');
            const overlay = document.querySelector('.custom-confirm-overlay');
            const iconWrapper = document.querySelector('.confirm-icon-wrapper');
            
            if (titleEl) titleEl.textContent = title;
            textEl.textContent = message;
            inputEl.style.display = 'none';
            
            if (isDangerous) {
                okBtn.className = 'confirm-btn confirm-btn-danger';
                // Reset to warning style
                iconWrapper.innerHTML = icons.warning.replace('width="18"', 'width="36"').replace('height="18"', 'height="36"');
                iconWrapper.style.color = '#fbc02d';
                iconWrapper.style.background = '#fff9c4';
            } else {
                okBtn.className = 'confirm-btn confirm-btn-ok';
                // Use info style
                iconWrapper.innerHTML = icons.info.replace('width="18"', 'width="36"').replace('height="18"', 'height="36"');
                iconWrapper.style.color = '#3498db';
                iconWrapper.style.background = 'rgba(52, 152, 219, 0.1)';
            }

            const close = (result) => {
                overlay.classList.remove('show');
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                setTimeout(() => resolve(result), 200);
            };

            okBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);

            overlay.classList.add('show');
        });
    };

    // 7. Show Prompt Function
    window.showPrompt = function(message, placeholder = '', title = 'Input Required') {
        return new Promise((resolve) => {
            const titleEl = document.getElementById('confirm-title');
            const textEl = document.getElementById('confirm-text');
            const inputEl = document.getElementById('confirm-input');
            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');
            const overlay = document.querySelector('.custom-confirm-overlay');
            
            if (titleEl) titleEl.textContent = title;
            textEl.textContent = message;
            inputEl.style.display = 'block';
            inputEl.value = '';
            inputEl.placeholder = placeholder;
            
            okBtn.className = 'confirm-btn confirm-btn-ok';

            const close = (result) => {
                overlay.classList.remove('show');
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                inputEl.onkeydown = null;
                setTimeout(() => resolve(result), 200);
            };

            okBtn.onclick = () => close(inputEl.value);
            cancelBtn.onclick = () => close(null);
            
            inputEl.onkeydown = (e) => {
                if(e.key === 'Enter') close(inputEl.value);
                if(e.key === 'Escape') close(null);
            };

            overlay.classList.add('show');
            setTimeout(() => inputEl.focus(), 100);
        });
    };

    // 8. Override Browser Alert
    window.alert = function(message) {
        showToast(message);
        console.log('Alert intercepted:', message);
    };

    console.log('Admin Toast System Initialized');
})();
