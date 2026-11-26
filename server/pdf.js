import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

// Gera a cópia final. Os bytes retornados são os mesmos usados na validação.
export async function renderPdf({ number, salon, customer, assessment, signature, photos, terms, publicity, verification, issued }) {
  const qr = await QRCode.toBuffer(verification, { width: 220, margin: 3 });
  const pdf = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  const ready = new Promise((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  const heading = text => pdf.moveDown().fillColor('#10243B').font('Helvetica-Bold').fontSize(15).text(text);
  const line = (label, value) => pdf.font('Helvetica').fontSize(11).text(`${label}: ${value || 'Não informado'}`);
  pdf.fillColor('#2457D6').font('Helvetica-Bold').fontSize(22).text('FichaPro');
  line('Estabelecimento', salon);
  heading('Ficha de avaliação capilar');
  line('Número', number);
  line('Cliente', customer.name);
  line('Procedimento desejado', customer.procedure);
  line('Química recente', customer.chemical);
  line('Histórico informado', customer.details);
  line('Reação relatada', customer.reaction);
  line('Observações da cliente', customer.notes);
  heading('Avaliação profissional');
  for (const [label, value] of Object.entries(assessment)) line(label, value);
  heading('Termos e assinatura');
  pdf.font('Helvetica').fontSize(11).text(terms);
  line('Divulgação das fotos', publicity ? 'Autorizada' : 'Sem autorização');
  line('Emissão', new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Manaus' }).format(new Date(issued)) + ' (Manaus)');
  for (const photo of photos) {
    if (pdf.y > 510) pdf.addPage();
    heading(photo.label);
    pdf.image(Buffer.from(photo.image.split(',')[1], 'base64'), { fit: [350, 180] });
  }
  if (pdf.y > 500) pdf.addPage();
  heading('Assinatura da cliente');
  pdf.image(Buffer.from(signature.split(',')[1], 'base64'), { fit: [240, 75] });
  if (pdf.y > 630) pdf.addPage();
  heading('Validação do documento');
  pdf.image(qr, { width: 100 });
  line('Código', number);
  const pages = pdf.bufferedPageRange();
  for (let page = 0; page < pages.count; page++) {
    pdf.switchToPage(page);
    pdf.fontSize(9).text(`${page + 1} / ${pages.count}`, 48, 790, { lineBreak: false });
  }
  pdf.end();
  return ready;
}
