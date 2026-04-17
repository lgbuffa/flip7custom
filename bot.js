require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INDEX_HTML = path.join(__dirname, 'index.html');
const CHANGES_LOG = path.join(__dirname, 'changes-log.json');

// chatId -> { description, modifiedHtml, request, user }
const pending = new Map();

// ---- Logger ----

function log(emoji, ...args) {
  const time = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`[${time}] ${emoji}`, ...args);
}

// ---- Helpers ----

function loadLog() {
  if (!fs.existsSync(CHANGES_LOG)) return [];
  try { return JSON.parse(fs.readFileSync(CHANGES_LOG, 'utf8')); }
  catch { return []; }
}

function saveLog(entry) {
  const entries = loadLog();
  entries.push(entry);
  fs.writeFileSync(CHANGES_LOG, JSON.stringify(entries, null, 2), 'utf8');
}

function formatUser(from) {
  return {
    id: from.id,
    username: from.username || '',
    first_name: from.first_name || '',
    last_name: from.last_name || '',
  };
}

function userName(user) {
  return user.first_name || user.username || `id:${user.id}`;
}

function escapeMd(text) {
  return text.replace(/[_*`[]/g, '\\$&');
}

function extractUrl(output) {
  const aliasLine = output.split('\n').find((l) => /aliased:/i.test(l));
  if (aliasLine) {
    const m = aliasLine.match(/https:\/\/[^\s]+/);
    if (m) return m[0];
  }
  const lines = output.trim().split('\n').filter(Boolean);
  const last = [...lines].reverse().find((l) => l.includes('vercel.app')) || lines[lines.length - 1];
  const m = last.match(/https:\/\/[^\s]+/);
  return m ? m[0] : last.trim();
}

function vercelApiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.vercel.com',
      path: urlPath,
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getProductionUrl() {
  const { projectId } = JSON.parse(fs.readFileSync(path.join(__dirname, '.vercel/project.json'), 'utf8'));
  const data = await vercelApiGet(`/v9/projects/${projectId}/domains`);
const domain = data.domains?.find((d) => !d.redirect);
  return domain ? `https://${domain.name}` : null;
}

// Baixa arquivo do Telegram para disco
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ---- Lógica principal de processamento ----

async function processRequest(chatId, user, request) {
  log('📩', `Mensagem de ${userName(user)}: "${request}"`);

  const processingMsg = await bot.sendMessage(chatId, '⏳ Analisando sua solicitação...');
  log('🤔', `Consultando Claude...`);

  try {
    const currentHtml = fs.readFileSync(INDEX_HTML, 'utf8');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: `Você é um assistente especializado em modificar o app web Flip7Custom.
Receberá o HTML atual do app e uma solicitação de alteração em português.
Sempre use a ferramenta "aplicar_alteracao" para retornar o resultado.`,
      tools: [
        {
          name: 'aplicar_alteracao',
          description: 'Aplica a alteração solicitada no HTML do app',
          input_schema: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Descrição clara em português do que será alterado (elemento, propriedade, valor antes e depois)',
              },
              modified_html: {
                type: 'string',
                description: 'HTML completo com as alterações aplicadas',
              },
            },
            required: ['description', 'modified_html'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'aplicar_alteracao' },
      messages: [
        {
          role: 'user',
          content: `HTML atual:\n${currentHtml}\n\nSolicitação: ${request}`,
        },
      ],
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse) throw new Error('Claude não retornou a ferramenta esperada.');
    const result = toolUse.input;

    pending.set(chatId, {
      description: result.description,
      modifiedHtml: result.modified_html,
      request,
      user,
    });

    log('💬', `Resposta enviada para ${userName(user)} — aguardando confirmação`);
    log('   ', `↳ ${result.description}`);

    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

    await bot.sendMessage(
      chatId,
      `📋 *Entendimento da alteração:*\n\n${escapeMd(result.description)}\n\nDeseja confirmar?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Confirmar', callback_data: 'confirm' },
              { text: '❌ Cancelar', callback_data: 'cancel' },
            ],
          ],
        },
      }
    );
  } catch (err) {
    log('❌', `Erro ao analisar solicitação de ${userName(user)}:`, err.message);
    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ Erro ao analisar solicitação:\n${err.message}`);
  }
}

// ---- Mensagem de texto ----

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  await processRequest(msg.chat.id, formatUser(msg.from), msg.text.trim());
});

// ---- Mensagem de áudio / voice ----

bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const user = formatUser(msg.from);
  log('🎙️', `Áudio recebido de ${userName(user)} (${msg.voice.duration}s)`);

  const transcribingMsg = await bot.sendMessage(chatId, '🎙️ Transcrevendo áudio...');

  try {
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const tempFile = path.join(__dirname, `voice_${msg.voice.file_id}.oga`);

    log('⬇️', `Baixando áudio...`);
    await downloadFile(fileLink, tempFile);

    log('📝', `Transcrevendo com Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: 'whisper-1',
      language: 'pt',
    });

    fs.unlink(tempFile, () => {});

    const text = transcription.text.trim();
    log('✍️', `Transcrição: "${text}"`);

    await bot.deleteMessage(chatId, transcribingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `🎙️ _Transcrição: "${text}"_`, { parse_mode: 'Markdown' });

    await processRequest(chatId, user, text);
  } catch (err) {
    log('❌', `Erro ao transcrever áudio de ${userName(user)}:`, err.message);
    await bot.deleteMessage(chatId, transcribingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ Erro ao transcrever áudio:\n${err.message}`);
  }
});

// ---- Confirmação / Cancelamento ----

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const user = formatUser(from);

  await bot.answerCallbackQuery(query.id);

  const change = pending.get(chatId);

  if (data === 'cancel') {
    pending.delete(chatId);
    log('❌', `${userName(user)} cancelou a alteração`);

    if (change) {
      saveLog({
        timestamp: new Date().toISOString(),
        user: change.user,
        request: change.request,
        description: change.description,
        status: 'cancelado',
      });
    }

    await bot.editMessageText('❌ Alteração cancelada.', {
      chat_id: chatId,
      message_id: message.message_id,
    });
    return;
  }

  if (data === 'confirm') {
    if (!change) {
      await bot.sendMessage(chatId, '⚠️ Sessão expirada. Envie a solicitação novamente.');
      return;
    }

    log('✅', `${userName(user)} confirmou — aplicando alteração e fazendo deploy...`);

    await bot.editMessageText('⏳ Aplicando alterações e fazendo deploy...', {
      chat_id: chatId,
      message_id: message.message_id,
    });

    try {
      fs.writeFileSync(INDEX_HTML, change.modifiedHtml, 'utf8');
      log('💾', `index.html atualizado`);

      log('🚀', `Iniciando deploy na Vercel...`);
      const deployOutput = execSync('npx vercel deploy --prod --yes --no-color', {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 120000,
      });

      let deployUrl;
      try { deployUrl = await getProductionUrl(); } catch {}
      if (!deployUrl) deployUrl = extractUrl(deployOutput);
      log('🌐', `Deploy concluído: ${deployUrl}`);

      log('📦', `Salvando alteração no Git...`);
      const gitName = process.env.GIT_USER_NAME || 'Flip7Custom Bot';
      const gitEmail = process.env.GIT_USER_EMAIL || 'bot@flip7custom.local';
      const commitMsg = `bot: ${change.request.slice(0, 72)}`;
      execSync(
        `git -c user.name="${gitName}" -c user.email="${gitEmail}" add index.html && ` +
        `git -c user.name="${gitName}" -c user.email="${gitEmail}" commit -m "${commitMsg.replace(/"/g, "'")}" && ` +
        `git push ${process.env.GIT_TOKEN ? `https://${process.env.GIT_TOKEN}@github.com/lgbuffa/flip7custom.git` : ''}`,
        { cwd: __dirname, encoding: 'utf8' }
      );
      log('✅', `Git commit + push concluído`);

      saveLog({
        timestamp: new Date().toISOString(),
        user: change.user,
        request: change.request,
        description: change.description,
        status: 'confirmado',
        deployment_url: deployUrl,
      });

      pending.delete(chatId);

      await bot.sendMessage(
        chatId,
        `✅ *Alteração aplicada com sucesso!*\n\n👤 Solicitante: ${escapeMd(userName(change.user))}\n📝 ${escapeMd(change.description)}\n\n🔗 ${deployUrl}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      log('❌', `Erro no deploy:`, err.message);
      await bot.sendMessage(chatId, `❌ Erro durante o deploy:\n${err.message}`);
    }
  }
});

// ---- Comando /url ----

bot.onText(/\/url/, async (msg) => {
  const chatId = msg.chat.id;
  log('🔗', `/url solicitado por ${userName(formatUser(msg.from))}`);

  try {
    const url = await getProductionUrl();
    if (url) {
      log('🔗', `URL de produção: ${url}`);
      await bot.sendMessage(chatId, `🔗 *URL de produção:*\n${url}`, { parse_mode: 'Markdown' });
      return;
    }
  } catch (err) {
    log('⚠️', `API Vercel indisponível:`, err.message);
  }

  const deployingMsg = await bot.sendMessage(chatId, '🚀 Fazendo deploy de produção...');
  log('🚀', `Nenhum domínio encontrado via API — iniciando deploy...`);

  try {
    const output = execSync('npx vercel deploy --prod --yes --no-color', {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 120000,
    });

    let deployUrl;
    try { deployUrl = await getProductionUrl(); } catch {}
    if (!deployUrl) deployUrl = extractUrl(output);

    log('🌐', `Deploy concluído: ${deployUrl}`);

    saveLog({
      timestamp: new Date().toISOString(),
      user: formatUser(msg.from),
      request: 'deploy via /url',
      description: 'Deploy de produção via /url',
      status: 'confirmado',
      deployment_url: deployUrl,
    });

    await bot.deleteMessage(chatId, deployingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `✅ *Deploy realizado!*\n\n🔗 ${deployUrl}`, { parse_mode: 'Markdown' });
  } catch (err) {
    log('❌', `Erro no deploy:`, err.message);
    await bot.sendMessage(chatId, `❌ Erro no deploy:\n${err.message}`);
  }
});

// ---- Comando /historico ----

bot.onText(/\/historico/, async (msg) => {
  const chatId = msg.chat.id;
  log('📋', `/historico solicitado por ${userName(formatUser(msg.from))}`);
  const entries = loadLog();

  if (entries.length === 0) {
    await bot.sendMessage(chatId, '📭 Nenhuma alteração registrada ainda.');
    return;
  }

  const recent = entries.slice(-10).reverse();
  const lines = recent.map((entry) => {
    const date = new Date(entry.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const who = entry.user.first_name || entry.user.username || `id:${entry.user.id}`;
    const status = entry.status === 'confirmado' ? '✅' : '❌';
    return `${status} *${date}*\n👤 ${who}\n📝 ${entry.request}`;
  });

  await bot.sendMessage(chatId, `📋 *Últimas alterações:*\n\n${lines.join('\n\n')}`, {
    parse_mode: 'Markdown',
  });
});

// ---- Comando /start ----

bot.onText(/\/start/, async (msg) => {
  log('👋', `/start de ${userName(formatUser(msg.from))}`);
  await bot.sendMessage(
    msg.chat.id,
    `👋 Olá! Sou o bot do *Flip7Custom*.\n\nEnvie uma mensagem de texto ou um *áudio* descrevendo a alteração que deseja fazer no app.\n\nExemplo: _"muda o botão de adicionar jogador para verde"_\n\nComandos:\n/url — URL atual do app\n/historico — últimas alterações`,
    { parse_mode: 'Markdown' }
  );
});

log('🤖', 'Bot Flip7Custom rodando...');
