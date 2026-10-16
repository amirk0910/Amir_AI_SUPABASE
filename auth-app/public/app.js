const screen = document.body.dataset.page;
const themePicker = document.getElementById('theme-picker');
const themes = { light: 'Light', dark: 'Dark', hc: 'High contrast' };

function setTheme(theme) {
  if (!Object.hasOwn(themes, theme)) return;
  document.documentElement.dataset.theme = theme;
  themePicker.querySelector('.lp-dropdown__trigger-label').textContent = themes[theme];
  try { localStorage.setItem('lepide-theme', theme); } catch {}
}

try { setTheme(localStorage.getItem('lepide-theme') || 'light'); } catch {}
themePicker.addEventListener('lp-dropdown-change', (event) => setTheme(event.detail.option.dataset.value));

function showError(message) {
  document.getElementById('form-error-text').textContent = message;
  document.getElementById('form-error').hidden = false;
}

async function requestApi(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message), { errors: data.errors, status: response.status });
  return data;
}

function setFieldError(input, message) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  input.closest('.lp-input__field').classList.toggle('lp-input__field--error', Boolean(message));
  const feedback = document.getElementById(`${input.id}-error`);
  feedback.textContent = message || '';
  feedback.hidden = !message;
}

const form = document.getElementById('auth-form');
if (form) {
  const inputs = [...form.querySelectorAll('.lp-input__input')];
  for (const input of inputs) {
    input.addEventListener('input', () => {
      setFieldError(input, '');
      document.getElementById('form-error').hidden = true;
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('submit-button');
    if (button.disabled) return;
    document.getElementById('form-error').hidden = true;
    const values = Object.fromEntries(new FormData(form));
    values.email = values.email.trim();
    if (values.name) values.name = values.name.trim();
    const errors = {};
    if (!values.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.';
    if (!values.password) errors.password = 'Enter your password.';
    if (screen === 'signup') {
      if (!values.name || values.name.length < 2) errors.name = 'Enter your full name (at least 2 characters).';
      if (values.password.length < 12 || values.password.length > 128) errors.password = 'Use between 12 and 128 characters.';
      if (!values.confirmPassword || values.confirmPassword !== values.password) errors.confirmPassword = 'Your passwords must match.';
    }
    for (const input of inputs) setFieldError(input, errors[input.name]);
    if (Object.keys(errors).length) {
      showError('Check the highlighted fields and try again.');
      inputs.find((input) => errors[input.name]).focus();
      return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = screen === 'signup' ? 'Creating account...' : 'Signing in...';
    form.setAttribute('aria-busy', 'true');
    try {
      await requestApi(screen, { name: values.name, email: values.email, password: values.password, remember: values.remember === 'on' });
      location.assign('/account');
    } catch (error) {
      showError(error.status ? error.message : 'Unable to connect. Check your connection and try again.');
      for (const input of inputs) if (error.errors?.[input.name]) setFieldError(input, error.errors[input.name]);
      button.disabled = false;
      button.textContent = originalLabel;
      form.setAttribute('aria-busy', 'false');
    }
  });
}

if (screen === 'account') {
  requestApi('me').then(({ user }) => {
    document.getElementById('welcome').textContent = `Welcome, ${user.name}`;
    document.getElementById('account-name').textContent = user.name;
    document.getElementById('account-email').textContent = user.email;
    document.getElementById('account-created').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(user.createdAt));
  }).catch((error) => {
    if (error.status === 401) location.replace('/login');
    else {
      showError('Unable to load your account. Refresh the page to try again.');
      for (const element of document.querySelectorAll('.detail-row dd')) element.textContent = 'Unavailable';
    }
  }).finally(() => document.getElementById('account-details').setAttribute('aria-busy', 'false'));
  document.getElementById('logout-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Signing out...';
    try {
      await requestApi('logout', {});
      location.replace('/login');
    } catch {
      showError('Unable to sign out. Please try again.');
      button.disabled = false;
      button.textContent = 'Sign out';
    }
  });
}