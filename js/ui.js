/**
 * Clean UI utility for replacing old alert() prompt() messages.
 */
const Modal = {
  _backdrop: null,
  _title: null,
  _message: null,
  _inputContainer: null,
  _input: null,
  _btnCancel: null,
  _btnOk: null,
  _resolve: null,

  init() {
    this._backdrop = document.getElementById('modal-backdrop');
    if (!this._backdrop) return;

    this._title = document.getElementById('modal-title');
    this._message = document.getElementById('modal-message');
    this._inputContainer = document.getElementById('modal-input-container');
    this._input = document.getElementById('modal-prompt-input');
    this._btnCancel = document.getElementById('modal-btn-cancel');
    this._btnOk = document.getElementById('modal-btn-ok');

    this._btnOk.addEventListener('click', () => this._onOk());
    this._btnCancel.addEventListener('click', () => this._onCancel());
    
    // Close on backdrop click (cancel)
    this._backdrop.addEventListener('click', (e) => {
      if (e.target === this._backdrop) this._onCancel();
    });

    // Keyboard support
    window.addEventListener('keydown', (e) => {
      if (!this._backdrop.classList.contains('open')) return;
      
      if (e.key === 'Enter') {
        e.preventDefault();
        this._onOk();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._onCancel();
      }
    });
  },

  /**
   * Show an alert-style modal.
   * @param {string} message 
   * @param {string} title 
   * @returns {Promise<boolean>}
   */
  alert(message, title = 'Notification') {
    return this._show(message, title, 'alert');
  },

  /**
   * Show a confirmation-style modal.
   * @param {string} message 
   * @param {string} title 
   * @returns {Promise<boolean>}
   */
  confirm(message, title = 'Confirm Action') {
    return this._show(message, title, 'confirm');
  },

  /**
   * Show a prompt-style modal with an input field.
   * @param {string} message 
   * @param {string} defaultValue 
   * @param {string} title 
   * @returns {Promise<string|boolean>} Returns the input string if OK, false if Cancelled.
   */
  prompt(message, defaultValue = '', title = 'Input Required') {
    return this._show(message, title, 'prompt', defaultValue);
  },

  _show(message, title, type, defaultValue = '') {
    if (!this._backdrop) this.init();

    this._title.textContent = title;
    this._message.textContent = message;
    
    // Reset states
    this._inputContainer.classList.add('hidden');
    this._btnCancel.classList.remove('hidden');
    this._btnOk.textContent = 'OK';

    if (type === 'alert') {
      this._btnCancel.classList.add('hidden');
    } else if (type === 'prompt') {
      this._inputContainer.classList.remove('hidden');
      this._input.value = defaultValue;
    } else if (type === 'confirm') {
        this._btnOk.textContent = 'Yes';
        this._btnCancel.textContent = 'No';
    }

    this._backdrop.classList.add('open');
    
    if (type === 'prompt') {
      setTimeout(() => {
        this._input.focus();
        this._input.select();
      }, 100);
    } else {
      setTimeout(() => this._btnOk.focus(), 100);
    }

    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  },

  _onOk() {
    if (!this._backdrop.classList.contains('open')) return;
    
    let result = true;
    if (!this._inputContainer.classList.contains('hidden')) {
      result = this._input.value;
    }
    
    this._close(result);
  },

  _onCancel() {
    if (!this._backdrop.classList.contains('open')) return;
    this._close(false);
  },

  _close(value) {
    this._backdrop.classList.remove('open');
    if (this._resolve) {
      const res = this._resolve;
      this._resolve = null;
      res(value);
    }
  }
};

/**
 * Toast notifications for non-blocking feedback.
 */
const Toast = {
  container: null,

  init() {
    this.container = document.querySelector('.toast-container');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },

  show(msg, type = 'success', duration = 3000) {
    if (!this.container) this.init();

    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    toast.textContent = msg;

    this.container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, duration + 300); // 300ms for animation
  }
};
