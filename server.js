require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PUSHINPAY_TOKEN = process.env.PUSHINPAY_TOKEN;
const PUSHINPAY_BASE  = 'https://api.pushinpay.com.br/api';
const CONFIGS_DIR     = path.join(__dirname, 'configs');
const UPLOADS_DIR     = path.join(__dirname, 'uploads');

// ── Upload de imagens ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload', upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── Checkouts (configs) ────────────────────────────────────────────────────
function lerConfig(id) {
  const file = path.join(CONFIGS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function salvarConfig(id, dados) {
  fs.writeFileSync(path.join(CONFIGS_DIR, `${id}.json`), JSON.stringify(dados, null, 2));
}

// Listar todos
app.get('/api/checkouts', (req, res) => {
  const files = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'));
  const lista = files.map(f => {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'));
    return { id: f.replace('.json', ''), nome: cfg.produto_nome, valor: cfg.produto_valor, criado: cfg.criado };
  });
  res.json(lista.sort((a, b) => new Date(b.criado) - new Date(a.criado)));
});

// Criar novo checkout
app.post('/api/checkouts', (req, res) => {
  const id = uuidv4().slice(0, 8);
  const defaults = {
    produto_nome:      'Meu Produto',
    produto_valor:     19.00,
    produto_descricao: 'Descrição do produto aqui...',
    produto_imagem:    '',
    banner_imagem:     '',
    banner_titulo:     'Transforme fotos simples em fotos e vídeos que lotam sua agenda',
    banner_subtitulo:  'Só copiar e colar',
    banner_badge:      'Antes → Depois',
    garantia_dias:     7,
    garantia_texto:    'Não ficou satisfeito? Devolvemos 100% do seu dinheiro sem perguntas.',
    garantia_imagem:   '',
    timer_minutos:     10,
    timer_ativo:       true,
    pix_imagem:        '',
    criado:            new Date().toISOString(),
    ...req.body,
  };
  salvarConfig(id, defaults);
  res.json({ id, ...defaults });
});

// Ler config
app.get('/api/checkouts/:id', (req, res) => {
  const cfg = lerConfig(req.params.id);
  if (!cfg) return res.status(404).json({ erro: 'Checkout não encontrado.' });
  res.json({ id: req.params.id, ...cfg });
});

// Atualizar config
app.put('/api/checkouts/:id', (req, res) => {
  const cfg = lerConfig(req.params.id);
  if (!cfg) return res.status(404).json({ erro: 'Checkout não encontrado.' });
  const atualizado = { ...cfg, ...req.body };
  salvarConfig(req.params.id, atualizado);
  res.json({ id: req.params.id, ...atualizado });
});

// Deletar
app.delete('/api/checkouts/:id', (req, res) => {
  const file = path.join(CONFIGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ erro: 'Não encontrado.' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ── Página do checkout ─────────────────────────────────────────────────────
app.get('/c/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// ── Admin ──────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── PIX: criar cobrança ────────────────────────────────────────────────────
app.post('/api/criar-cobranca', async (req, res) => {
  const { nome, email, cpf, celular, valor, descricao } = req.body;
  if (!nome || !email || !cpf || !valor)
    return res.status(400).json({ erro: 'Campos obrigatórios faltando.' });

  try {
    const payload = {
      value: Math.round(valor * 100),
      webhook_url: process.env.WEBHOOK_URL,
      payer: {
        name: nome,
        email: email,
        document: cpf.replace(/\D/g, ''),
        phone: celular ? celular.replace(/\D/g, '') : undefined,
      },
      metadata: { descricao: descricao || 'Compra', email },
    };

    const response = await axios.post(`${PUSHINPAY_BASE}/pix/cashIn`, payload, {
      headers: { Authorization: `Bearer ${PUSHINPAY_TOKEN}`, 'Content-Type': 'application/json' },
    });

    const data = response.data;
    res.json({
      id:           data.id,
      qrcode:       data.qr_code,
      qrcode_image: data.qr_code_base64,
      status:       data.status,
      valor:        data.value,
    });
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('Erro PushinPay:', msg);
    res.status(500).json({ erro: 'Erro ao criar cobrança.', detalhe: msg });
  }
});

// ── Consultar status ───────────────────────────────────────────────────────
app.get('/api/status/:id', async (req, res) => {
  try {
    const response = await axios.get(`${PUSHINPAY_BASE}/transactions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${PUSHINPAY_TOKEN}` },
    });
    res.json({ id: response.data.id, status: response.data.status });
  } catch {
    res.status(500).json({ erro: 'Erro ao consultar status.' });
  }
});

// ── Webhook ────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  const evento = req.body;
  console.log('📩 Webhook:', JSON.stringify(evento, null, 2));
  const tipo = evento.event || evento.type;
  const t    = evento.transaction || evento;
  if (tipo === 'transaction.paid' || tipo === 'PAYMENT_RECEIVED')
    console.log(`✅ Pago! ID: ${t.id}`);
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}/admin`));
