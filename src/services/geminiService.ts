import { GoogleGenAI, Type } from "@google/genai";
import { DocumentType } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function summarizeText(text: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Please provide a concise, well-formatted summary of the following text extracted from a PDF document. Use bullet points for key takeaways.

Text:
${text}`,
    config: {
      systemInstruction: "You are a helpful assistant that summarizes documents accurately and concisely.",
    },
  });

  return response.text;
}

export async function chatWithPdf(text: string, question: string, docType: DocumentType) {
  const systemInstructions: Record<DocumentType, string> = {
    general: "You are a helpful assistant answering questions about a general document.",
    contract: "You are a legal-minded assistant. Focus on terms, dates, obligations, and liabilities when answering questions about this contract.",
    textbook: "You are an educational tutor. Explain concepts clearly and provide context when answering questions about this textbook.",
    research: "You are a scientific researcher. Focus on methodology, results, and conclusions when answering questions about this research paper.",
    legal: "You are a legal expert. Provide precise answers based on the legal text provided, highlighting specific clauses or references.",
  };

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      { text: `Context from PDF (${docType}):\n${text}` },
      { text: `User Question: ${question}` }
    ],
    config: {
      systemInstruction: systemInstructions[docType] || systemInstructions.general,
    },
  });

  return response.text;
}

export async function smartFillForm(fields: string[], userProfile: string, docType: DocumentType) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        text: `Based on the following user profile and document type, guess the values for the requested fields. If you don't know, leave it empty.

User Profile:
${userProfile}

Document Type:
${docType}

Fields to fill:
${fields.join(", ")}

Return a JSON object where keys are the field labels and values are the guessed strings.`,
      },
    ],
    config: {
      responseMimeType: "application/json",
    },
  });

  try {
    const text = response.text;
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse smart fill JSON:", e);
    return {};
  }
}

export async function detectGapsFromImage(base64Image: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        inlineData: {
          mimeType: "image/png",
          data: base64Image,
        },
      },
      {
        text: "Analyze this document image and find all fillable fields (empty lines, boxes, or checkboxes). For each field, identify the label and the EXACT [x, y] coordinates for the START of the input area. This is the point where the first character should be typed. Return a JSON array of objects: { 'label': string, 'x': number (0-1000), 'y': number (0-1000) }. Accuracy is critical. Use the full 0-1000 range for precision.",
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING },
            x: { type: Type.NUMBER },
            y: { type: Type.NUMBER },
          },
          required: ["label", "x", "y"],
        },
      },
    },
  });

  try {
    const text = response.text;
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse gaps JSON:", e);
    return [];
  }
}
