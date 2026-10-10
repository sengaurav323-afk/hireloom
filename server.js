const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PORT = process.env.PORT || 3030;
const DATA_DIR = path.join(__dirname, 'work', 'data');
const STORE_PATH = path.join(DATA_DIR, 'pathway.json');

const SKILL_TERMS = [
  'Figma', 'Sketch', 'Adobe XD', 'Miro', 'Notion', 'Jira', 'Confluence', 'HTML', 'CSS', 'JavaScript',
  'TypeScript', 'React', 'Python', 'SQL', 'Excel', 'Tableau', 'Power BI', 'UX Research', 'User Research',
  'Wireframing', 'Prototyping', 'Design Systems', 'Product Design', 'Agile', 'Scrum', 'AWS', 'Git'
];

function unique(items) { return [...new Set(items.filter(Boolean))]; }
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { profile: null, jobs: [], applications: [], activity: [] }; }
}
function saveStore(store) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); }
function log(store, action, source = 'Pathway local app') {
  store.activity.unshift({ id: crypto.randomUUID(), action, source, at: new Date().toISOString() });
  store.activity = store.activity.slice(0, 100);
}
function jobScore(profile, job) {
  if (!profile) return { score: 0, reasons: ['Upload a master resume to calculate an evidence-based match.'], gaps: [] };
  const haystack = `${job.title} ${job.company} ${job.description || ''}`.toLowerCase();
  const matched = (profile.skills || []).filter(skill => haystack.includes(skill.toLowerCase()));
  const skillRate = profile.skills?.length ? matched.length / profile.skills.length : 0;
  const location = profile.location && job.location && job.location.toLowerCase().includes(profile.location.toLowerCase()) ? 1 : /remote/i.test(job.location || '') ? .8 : 0;
  const score = Math.min(100, Math.round(35 + skillRate * 50 + location * 15));
  const gaps = [...new Set((job.requiredSkills || []).filter(skill => !(profile.skills || []).some(owned => owned.toLowerCase() === skill.toLowerCase())))];
  const reasons = [matched.length ? `Matched skills: ${matched.join(', ')}.` : 'No listed resume skills were found in this job description.', location ? `Location preference aligns with ${job.location}.` : 'Location alignment needs review.'];
  return { score, reasons, gaps };
}
function makeResume(profile, job) {
  const terms = (profile.skills || []).filter(skill => `${job.title} ${job.description || ''}`.toLowerCase().includes(skill.toLowerCase()));
  const experience = profile.sections.Experience || profile.sections['Work Experience'] || profile.sections.Employment || '';
  const education = profile.sections.Education || '';
  return `# ${profile.name || 'Candidate'}\n${[profile.email, profile.phone, profile.location].filter(Boolean).join(' | ')}\n\n## Professional summary\nCandidate profile tailored for ${job.title} at ${job.company}. This version uses only claims extracted from the uploaded master resume.\n\n## Relevant skills\n${terms.length ? terms.join(' · ') : (profile.skills || []).join(' · ') || 'Review and add verified skills manually'}\n\n## Experience\n${experience || 'Experience details were not identified as a section in the uploaded resume. Review the master resume before use.'}\n\n## Education\n${education || 'Education details were not identified as a section in the uploaded resume.'}\n\n## Tailoring note\nKeywords were selected only where supported by the candidate profile. No requirements were added as claimed experience.`;
}
function lineValue(text, label) {
  const match = text.match(new RegExp(`${label}\\s*[:\\-]\\s*([^\\n]{2,100})`, 'i'));
  return match ? match[1].trim() : '';
}
function extractProfile(text, filename) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const lines = clean.split('\n').map(s => s.trim()).filter(Boolean);
  const email = (clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
  const phone = (clean.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]\d{3,5}/) || [''])[0];
  const skills = SKILL_TERMS.filter(skill => new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clean));
  const headings = ['Education', 'Experience', 'Work Experience', 'Employment', 'Certifications', 'Projects', 'Achievements'];
  const sections = {};
  for (const heading of headings) {
    const exp = new RegExp(`(?:^|\\n)${heading}\\s*(?:\\n|$)([\\s\\S]*?)(?=\\n(?:${headings.join('|')})\\s*(?:\\n|$)|$)`, 'i');
    const found = clean.match(exp);
    if (found) sections[heading] = found[1].trim().slice(0, 1200);
  }
  const likelyName = lines.find(line => !/@|\d{5,}|linkedin|github|resume|curriculum vitae/i.test(line) && line.length < 55) || '';
  return {
    filename,
    name: likelyName,
    email,
    phone,
    location: lineValue(clean, 'Location'),
    preferredRoles: lineValue(clean, 'Preferred (?:roles?|positions?)'),
    noticePeriod: lineValue(clean, 'Notice period'),
    salaryExpectation: lineValue(clean, '(?:Salary expectation|Expected salary|CTC)'),
    skills: unique(skills),
    sections,
    textPreview: clean.slice(0, 2600),
    extractedAt: new Date().toISOString()
  };
}

async function readResume(file) {
  if (/\.docx$/i.test(file.originalname)) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  if (/\.pdf$/i.test(file.originalname)) {
    const parser = new PDFParse({ data: file.buffer });
    try { const result = await parser.getText(); return result.text; } finally { await parser.destroy(); }
  }
  throw new Error('Only PDF and DOCX resumes are supported.');
}

app.use(express.json());
app.get("/", (req, res) => res.sendFile(require("path").join(__dirname, "index.html")));
app.get('/api/state', (req, res) => res.json(loadStore()));
app.post('/api/resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please choose a PDF or DOCX resume.' });
    if (!/\.(pdf|docx)$/i.test(req.file.originalname)) return res.status(400).json({ error: 'Only PDF and DOCX resumes are supported.' });
    const text = await readResume(req.file);
    if (!text || text.trim().length < 20) return res.status(422).json({ error: 'No readable resume text was found. Try a text-based PDF or DOCX file.' });
    const profile = extractProfile(text, req.file.originalname);
    const store = loadStore(); store.profile = profile; log(store, `Uploaded and extracted ${req.file.originalname}`, 'Local resume parser'); saveStore(store);
    res.json({ profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'We could not read that resume. Please try a standard PDF or DOCX file.' });
  }
});
app.post('/api/jobs', (req, res) => {
  const { title, company, location = '', url = '', source = 'Manual entry', description = '', requiredSkills = [] } = req.body || {};
  if (!title?.trim() || !company?.trim()) return res.status(400).json({ error: 'Job title and company are required.' });
  const store = loadStore();
  const duplicate = store.jobs.find(job => (url && job.url === url) || (job.title.toLowerCase() === title.toLowerCase() && job.company.toLowerCase() === company.toLowerCase()));
  if (duplicate) return res.status(409).json({ error: 'This job is already in your tracker.' });
  const job = { id: crypto.randomUUID(), title: title.trim(), company: company.trim(), location: location.trim(), url: url.trim(), source, description, requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [], discoveredAt: new Date().toISOString() };
  Object.assign(job, jobScore(store.profile, job)); store.jobs.unshift(job); log(store, `Added ${job.title} at ${job.company} — ${job.score}% match`, source); saveStore(store); res.status(201).json(job);
});
app.post('/api/jobs/:id/prepare', (req, res) => {
  const store = loadStore(); const job = store.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' }); if (!store.profile) return res.status(400).json({ error: 'Upload a master resume first.' });
  const sensitive = /salary|compensation|assessment|test|declaration|citizen|visa|disability|criminal/i.test(job.description || '');
  const application = { id: crypto.randomUUID(), jobId: job.id, title: job.title, company: job.company, source: job.source, status: sensitive ? 'Approval required' : 'Ready', discoveredAt: job.discoveredAt, resume: makeResume(store.profile, job), resumeVersion: `Tailored · ${new Date().toLocaleDateString('en-CA')}`, actionRequired: sensitive ? 'Review job requirements and approve sensitive declarations before submission.' : '', notes: '', updatedAt: new Date().toISOString() };
  store.applications.unshift(application); log(store, `Prepared truthful resume for ${job.title} at ${job.company}`, 'Resume tailoring engine'); saveStore(store); res.status(201).json(application);
});
app.patch('/api/applications/:id', (req, res) => {
  const store = loadStore(); const item = store.applications.find(app => app.id === req.params.id); if (!item) return res.status(404).json({ error: 'Application not found.' });
  const allowed = ['status', 'notes', 'followUpDate', 'response']; for (const key of allowed) if (key in req.body) item[key] = req.body[key]; item.updatedAt = new Date().toISOString(); log(store, `Updated ${item.title} at ${item.company}: ${item.status}`, 'Candidate tracker'); saveStore(store); res.json(item);
});
app.get('/api/applications/:id/resume.txt', (req, res) => { const item = loadStore().applications.find(app => app.id === req.params.id); if (!item) return res.status(404).send('Not found'); res.type('text/plain').attachment(`${item.company}-${item.title}-resume.txt`.replace(/[^a-z0-9.-]/gi, '_')).send(item.resume); });
app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Upload failed.' }));
app.listen(PORT, () => console.log(`Pathway is running at http://localhost:${PORT}`));
