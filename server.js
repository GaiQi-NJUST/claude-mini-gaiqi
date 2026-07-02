const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config for skill import
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ============ API Routes ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Chat — routes to Anthropic or third-party (OpenAI-compatible)
app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages, apiKey, model, systemPrompt, skills,
      apiMode, thirdApiKey, thirdApiBase, thirdApiModel
    } = req.body;

    if (apiMode === 'third-party') {
      return handleThirdPartyChat(req, res);
    }

    // ── Anthropic API ──────────────────────────
    if (!apiKey) {
      return res.status(400).json({ error: '请提供 API Key' });
    }

    // Build system prompt from loaded skills
    let system = systemPrompt || '';
    if (skills && skills.length > 0) {
      const skillsContext = skills
        .map(s => `<skill name="${s.name}">\n${s.content}\n</skill>`)
        .join('\n\n');
      system = `${system}\n\n<loaded_skills>\n${skillsContext}\n</loaded_skills>\n\n---\n以上是你的可用技能。当用户指令匹配某技能时，严格按照该技能的指令执行。`;
    }

    const anthropic = new Anthropic({ apiKey });

    // Convert to Anthropic format
    const systemMessages = messages
      .filter(m => m.role === 'system')
      .map(m => ({ type: 'text', text: m.content }));

    const allSystem = [
      ...(system ? [{ type: 'text', text: system }] : []),
      ...systemMessages,
    ];

    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const stream = await anthropic.messages.stream({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: allSystem.length > 0 ? allSystem : undefined,
      messages: conversationMessages,
    });

    // Stream the response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
      }
    }

    // Get final message for token usage
    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage;
    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
});

// ── Third-party (OpenAI-compatible) chat ────────
async function handleThirdPartyChat(req, res) {
  const {
    messages, skills,
    thirdApiKey, thirdApiBase, thirdApiModel
  } = req.body;

  if (!thirdApiKey) {
    return res.status(400).json({ error: '请提供第三方 API Key' });
  }
  if (!thirdApiBase) {
    return res.status(400).json({ error: '请提供第三方 API Base URL' });
  }

  // Build system content
  let systemContent = '';
  if (skills && skills.length > 0) {
    const skillsContext = skills
      .map(s => `<skill name="${s.name}">\n${s.content}\n</skill>`)
      .join('\n\n');
    systemContent = `\n\n<loaded_skills>\n${skillsContext}\n</loaded_skills>\n\n---\n以上是你的可用技能。当用户指令匹配某技能时，严格按照该技能的指令执行。`;
  }

  // Build OpenAI-format messages
  const openaiMessages = [];
  if (systemContent) {
    openaiMessages.push({ role: 'system', content: systemContent });
  }
  messages
    .filter(m => m.role !== 'system')
    .forEach(m => {
      openaiMessages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    });

  const apiUrl = thirdApiBase.replace(/\/+$/, '') + '/chat/completions';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${thirdApiKey}`,
      },
      body: JSON.stringify({
        model: thirdApiModel || 'gpt-4o',
        messages: openaiMessages,
        stream: true,
        max_tokens: 4096,
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`第三方 API 错误 (${response.status}): ${errText}`);
    }

    // Stream the response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);
          const choice = data.choices?.[0];
          if (choice?.delta?.content) {
            res.write(`data: ${JSON.stringify({ type: 'text', text: choice.delta.content })}\n\n`);
          }
          if (data.usage) {
            totalInputTokens = data.usage.prompt_tokens || 0;
            totalOutputTokens = data.usage.completion_tokens || 0;
          }
        } catch (_) {}
      }
    }

    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
    })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Third-party chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
}

// List available models
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: '最强大，适合复杂任务' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: '平衡性能与速度' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: '最快，适合简单任务' },
      { id: 'claude-fable-5', name: 'Claude Fable 5', description: '最新模型' },
    ],
  });
});

// ── Built-in skills ──────────────────────────────
// List skills from the /skills/ directory
app.get('/api/skills/builtin', (req, res) => {
  try {
    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) {
      return res.json({ skills: [] });
    }

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    const skills = files.map(fileName => {
      const content = fs.readFileSync(path.join(skillsDir, fileName), 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let name = fileName.replace(/\.md$/, '');
      let description = '';
      let skillContent = content;

      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        skillContent = frontmatterMatch[2];
        const nm = fm.match(/name:\s*(.+)/);
        const dm = fm.match(/description:\s*(.+)/);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }

      return { name, description, content: skillContent.trim(), builtin: true };
    });

    res.json({ skills });
  } catch (error) {
    console.error('Built-in skills error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skill from file upload
app.post('/api/skills/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const filePath = req.file.path;
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = req.file.originalname;

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let name = fileName.replace(/\.(md|txt)$/i, '');
    let description = '';
    let skillContent = content;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      skillContent = frontmatterMatch[2];
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    fs.unlinkSync(filePath);

    res.json({
      name,
      description,
      content: skillContent.trim(),
      raw: content,
      importedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skill from text
app.post('/api/skills/import-text', (req, res) => {
  try {
    const { text, fileName } = req.body;
    if (!text) return res.status(400).json({ error: '请提供文本内容' });

    const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let name = (fileName || 'custom').replace(/\.(md|txt)$/i, '');
    let description = '';
    let skillContent = text;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      skillContent = frontmatterMatch[2];
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    res.json({
      name,
      description,
      content: skillContent.trim(),
      raw: text,
      importedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Import text error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import skills from directory (batch)
app.post('/api/skills/import-directory', (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: '请提供文件列表' });
    }

    const skills = files.map(f => {
      const frontmatterMatch = f.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let name = f.name.replace(/\.(md|txt)$/i, '');
      let description = '';
      let skillContent = f.content;

      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        skillContent = frontmatterMatch[2];
        const nm = fm.match(/name:\s*(.+)/);
        const dm = fm.match(/description:\s*(.+)/);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }

      return { name, description, content: skillContent.trim(), raw: f.content };
    });

    res.json({ skills, count: skills.length });
  } catch (error) {
    console.error('Batch import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🤖 Claude Mobile Web running at http://localhost:${PORT}`);
  console.log(`📱 Open in your browser or phone to use`);
  console.log(`🔑 Set your API key in Settings (profile → settings)`);
  console.log(`📂 Import skills via the skills panel`);
  console.log(`📦 Built-in skills: ${fs.existsSync(path.join(__dirname, 'skills')) ? fs.readdirSync(path.join(__dirname, 'skills')).filter(f => f.endsWith('.md')).length : 0} loaded`);
});
