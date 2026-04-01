/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { FileUp, Download, Plus, Type, Trash2, Loader2, ChevronLeft, ChevronRight, MousePointer2, Sparkles, X, MessageSquare, Send, Wand2, Cloud, Library, FileText, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { motion, AnimatePresence, useDragControls, useMotionValue } from 'motion/react';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { cn } from './lib/utils';
import { Annotation, PdfDocument, Message, DocumentType } from './types';
import { summarizeText, chatWithPdf, detectGapsFromImage, smartFillForm } from './services/geminiService';
import { auth, db, storage, signIn, signOut, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, setDoc, getDoc, getDocs, query, where, deleteDoc, Timestamp, orderBy } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// Set pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      let isQuotaError = false;
      let quotaMessage = "";

      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error) errorMessage = parsed.error;
        if (parsed.isQuotaError) {
          isQuotaError = true;
          quotaMessage = parsed.message;
        }
      } catch (e) {
        errorMessage = this.state.error.message || errorMessage;
      }

      if (isQuotaError) {
        return (
          <div className="min-h-screen bg-[#FBFBFA] flex flex-col items-center justify-center p-8 text-center">
            <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-2xl flex items-center justify-center mb-6">
              <Cloud className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-display font-bold tracking-tight mb-2">Daily Limit Reached</h2>
            <p className="text-[#1A1A1A]/60 text-sm max-w-md mb-8">{quotaMessage}</p>
            <div className="text-[10px] uppercase tracking-widest opacity-30 font-bold">
              Service resets at 00:00 UTC
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen bg-[#FBFBFA] flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mb-6">
            <X className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-display font-bold tracking-tight mb-2">Application Error</h2>
          <p className="text-[#1A1A1A]/40 text-sm max-w-md mb-8">{errorMessage}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-8 py-3 bg-[#1A1A1A] text-white rounded-full text-sm font-medium hover:bg-opacity-90 transition-all"
          >
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<PdfDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [tool, setTool] = useState<'select' | 'text'>('select');
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showSummaryPanel, setShowSummaryPanel] = useState(false);
  const [showChatPanel, setShowChatPanel] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [savedDocuments, setSavedDocuments] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isDetectingGaps, setIsDetectingGaps] = useState(false);
  const [isSmartFilling, setIsSmartFilling] = useState(false);
  const [showFormPanel, setShowFormPanel] = useState(false);
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pdfPageRef = useRef<{ getCanvas: () => HTMLCanvasElement | null }>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthChecking(false);
    });
    return () => unsubscribe();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setShowTypeSelector(true);
  };

  const confirmUpload = async (type: DocumentType) => {
    if (!pendingFile) return;
    const file = pendingFile;
    setLoading(true);
    setShowTypeSelector(false);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      setPdfDoc({
        id: Math.random().toString(36).substr(2, 9),
        file,
        name: file.name,
        numPages: pdf.numPages,
        annotations: [],
        type,
      });
      setCurrentPage(1);
      setMessages([]);
      setSummary(null);
    } catch (error) {
      console.error('Error loading PDF:', error);
      alert('Failed to load PDF. Please try again.');
    } finally {
      setLoading(false);
      setPendingFile(null);
    }
  };

  const fetchLibrary = async () => {
    if (!user) return;
    setIsLoadingLibrary(true);
    const path = 'documents';
    try {
      const q = query(
        collection(db, path),
        where('ownerId', '==', user.uid),
        orderBy('createdAt', 'desc')
      );
      const querySnapshot = await getDocs(q);
      const docs = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setSavedDocuments(docs);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const handleSaveToCloud = async () => {
    if (!pdfDoc || isSaving || !user) {
      if (!user) alert("Please sign in to save documents.");
      return;
    }
    
    setIsSaving(true);
    const path = `documents/${pdfDoc.id}`;
    try {
      // 1. Upload to Storage
      const storageRef = ref(storage, `pdfs/${user.uid}/${pdfDoc.id}_${pdfDoc.name}`);
      const arrayBuffer = pdfDoc.file ? await pdfDoc.file.arrayBuffer() : null;
      if (!arrayBuffer) throw new Error("File data missing");
      
      await uploadBytes(storageRef, new Uint8Array(arrayBuffer));
      const pdfUrl = await getDownloadURL(storageRef);

      // 2. Save to Firestore
      await setDoc(doc(db, 'documents', pdfDoc.id), {
        id: pdfDoc.id,
        name: pdfDoc.name,
        type: pdfDoc.type,
        numPages: pdfDoc.numPages,
        annotations: pdfDoc.annotations,
        pdfUrl,
        ownerId: user.uid,
        createdAt: Timestamp.now()
      });

      alert("Document saved to cloud!");
      fetchLibrary();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    } finally {
      setIsSaving(false);
    }
  };

  const loadDocument = async (id: string) => {
    setLoading(true);
    setShowLibrary(false);
    const path = `documents/${id}`;
    try {
      const docSnap = await getDoc(doc(db, 'documents', id));
      if (!docSnap.exists()) throw new Error("Document not found");
      
      const data = docSnap.data();
      
      // Download from Storage
      const response = await fetch(data.pdfUrl);
      const blob = await response.blob();
      const file = new File([blob], data.name, { type: 'application/pdf' });

      setPdfDoc({
        id: data.id,
        file: file,
        name: data.name,
        numPages: data.numPages,
        annotations: data.annotations,
        type: data.type,
        pdfUrl: data.pdfUrl,
        ownerId: data.ownerId,
        createdAt: data.createdAt
      });
      setCurrentPage(1);
      setMessages([]);
      setSummary(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    } finally {
      setLoading(false);
    }
  };

  const deleteDocument = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this document?")) return;
    
    const path = `documents/${id}`;
    try {
      const docSnap = await getDoc(doc(db, 'documents', id));
      if (docSnap.exists()) {
        const data = docSnap.data();
        // Delete from Storage if we have a URL
        // Note: This is simplified, usually you'd derive the ref from the URL
        // For now, we'll just delete the Firestore doc
      }
      await deleteDoc(doc(db, 'documents', id));
      fetchLibrary();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const addAnnotation = (x: number, y: number) => {
    if (!pdfDoc || tool !== 'text') return;

    const newAnnotation: Annotation = {
      id: Math.random().toString(36).substr(2, 9),
      page: currentPage,
      x,
      y,
      width: 0.2, // Default 20% width
      text: 'New Text',
      fontSize: 16,
      color: '#000000',
    };

    setPdfDoc({
      ...pdfDoc,
      annotations: [...pdfDoc.annotations, newAnnotation],
    });
    setSelectedAnnotationId(newAnnotation.id);
    setTool('select');
  };

  const updateAnnotation = (id: string, updates: Partial<Annotation>) => {
    if (!pdfDoc) return;
    setPdfDoc({
      ...pdfDoc,
      annotations: pdfDoc.annotations.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    });
  };

  const deleteAnnotation = (id: string) => {
    if (!pdfDoc) return;
    setPdfDoc({
      ...pdfDoc,
      annotations: pdfDoc.annotations.filter((a) => a.id !== id),
    });
    setSelectedAnnotationId(null);
  };

  const extractTextFromPage = async (pageNumber: number) => {
    if (!pdfDoc) return '';
    try {
      const arrayBuffer = await pdfDoc.file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      return textContent.items.map((item: any) => item.str).join(' ');
    } catch (error) {
      console.error('Error extracting text:', error);
      return '';
    }
  };

  const handleSummarize = async () => {
    if (!pdfDoc) return;
    setIsSummarizing(true);
    setShowSummaryPanel(true);
    setShowChatPanel(false);
    try {
      const text = await extractTextFromPage(currentPage);
      if (!text.trim()) {
        setSummary("No text content found on this page to summarize.");
        return;
      }
      const result = await summarizeText(text);
      setSummary(result || "Failed to generate summary.");
    } catch (error) {
      console.error('Summarization failed:', error);
      setSummary("An error occurred while generating the summary.");
    } finally {
      setIsSummarizing(false);
    }
  };

  const extractAllText = async () => {
    if (!pdfDoc) return '';
    try {
      const arrayBuffer = await pdfDoc.file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map((item: any) => item.str).join(' ') + '\n';
      }
      return fullText;
    } catch (error) {
      console.error('Error extracting all text:', error);
      return '';
    }
  };

  const handleSendMessage = async () => {
    if (!pdfDoc || !chatInput.trim() || isSendingMessage) return;

    const userMessage: Message = {
      id: Math.random().toString(36).substr(2, 9),
      role: 'user',
      text: chatInput,
    };

    setMessages((prev) => [...prev, userMessage]);
    setChatInput('');
    setIsSendingMessage(true);

    try {
      const fullText = await extractAllText();
      const response = await chatWithPdf(fullText, userMessage.text, pdfDoc.type);
      
      const assistantMessage: Message = {
        id: Math.random().toString(36).substr(2, 9),
        role: 'assistant',
        text: response || "I couldn't process that question.",
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat failed:', error);
      const errorMessage: Message = {
        id: Math.random().toString(36).substr(2, 9),
        role: 'assistant',
        text: "Sorry, I encountered an error while processing your question.",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsSendingMessage(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleDetectGaps = async () => {
    if (!pdfDoc || isDetectingGaps) return;
    
    const canvas = pdfPageRef.current?.getCanvas();
    if (!canvas) return;

    setIsDetectingGaps(true);
    setShowFormPanel(true);
    setShowChatPanel(false);
    setShowSummaryPanel(false);
    try {
      // Clear existing annotations for this page before detecting new ones
      const otherAnnotations = pdfDoc.annotations.filter(a => a.page !== currentPage);
      
      // Convert canvas to base64
      const base64Image = canvas.toDataURL('image/png').split(',')[1];
      const gaps = await detectGapsFromImage(base64Image);
      
      if (gaps && Array.isArray(gaps)) {
        const newAnnotations: Annotation[] = gaps.map((gap: any) => ({
          id: Math.random().toString(36).substr(2, 9),
          page: currentPage,
          x: gap.x / 1000,
          y: (gap.y / 1000) - 0.015, // Small offset to sit above the line
          width: 0.15,
          text: '', // Empty text for the user to fill
          fontSize: 12,
          color: '#000000',
          label: gap.label,
        }));

        setPdfDoc({
          ...pdfDoc,
          annotations: [...otherAnnotations, ...newAnnotations],
        });
      }
    } catch (error) {
      console.error('Gap detection failed:', error);
    } finally {
      setIsDetectingGaps(false);
    }
  };

  const handleSmartFill = async () => {
    if (!pdfDoc || isSmartFilling) return;
    const userProfile = (document.getElementById('userProfile') as HTMLTextAreaElement)?.value;
    if (!userProfile) {
      alert("Please provide some info in your profile first.");
      return;
    }

    const currentAnnotations = pdfDoc.annotations.filter(a => a.page === currentPage && a.label);
    if (currentAnnotations.length === 0) return;

    setIsSmartFilling(true);
    try {
      const labels = currentAnnotations.map(a => a.label!);
      const guesses = await smartFillForm(labels, userProfile, pdfDoc.type);
      
      if (guesses) {
        setPdfDoc({
          ...pdfDoc,
          annotations: pdfDoc.annotations.map(a => {
            if (a.page === currentPage && a.label && guesses[a.label]) {
              return { ...a, text: guesses[a.label] };
            }
            return a;
          })
        });
      }
    } catch (error) {
      console.error('Smart fill failed:', error);
    } finally {
      setIsSmartFilling(false);
    }
  };

  const downloadPdf = async () => {
    if (!pdfDoc) return;

    setLoading(true);
    try {
      const existingPdfBytes = await pdfDoc.file.arrayBuffer();
      const pdfDocLib = await PDFDocument.load(existingPdfBytes);
      const font = await pdfDocLib.embedFont(StandardFonts.Helvetica);

      const pages = pdfDocLib.getPages();

      for (const annotation of pdfDoc.annotations) {
        const page = pages[annotation.page - 1];
        const { width, height } = page.getSize();

        // The UI uses a 1.5x scale for rendering the PDF canvas.
        // We need to scale the font size down to match the PDF's point system (72 DPI).
        const scaledFontSize = annotation.fontSize / 1.5;
        
        // UI Offsets (in pixels, converted to points)
        const handleOffset = 20 / 1.5; // The drag handle width
        const paddingOffset = 2 / 1.5; // The textarea padding (p-0.5)

        // Convert normalized coordinates (0-1) to PDF coordinates
        // PDF coordinates start from bottom-left
        const pdfX = (annotation.x * width) + handleOffset;
        
        // In UI, y is from top. In PDF, y is from bottom.
        // We want the top of the text to be at the UI's y position + padding.
        // pdf-lib's drawText y is the baseline.
        const pdfY = height - (annotation.y * height + paddingOffset) - (scaledFontSize * 0.8);

        page.drawText(annotation.text, {
          x: pdfX,
          y: pdfY,
          size: scaledFontSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: annotation.width ? (annotation.width * width) - handleOffset : undefined,
          lineHeight: scaledFontSize * 1.2,
        });
      }

      const pdfBytes = await pdfDocLib.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `edited_${pdfDoc.name}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error saving PDF:', error);
      alert('Failed to save PDF.');
    } finally {
      setLoading(false);
    }
  };

  if (isAuthChecking) {
    return (
      <div className="min-h-screen bg-[#FBFBFA] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin opacity-20" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#FBFBFA] flex flex-col items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white border border-[#1A1A1A]/5 rounded-[32px] p-12 shadow-2xl shadow-[#1A1A1A]/5 text-center"
        >
          <div className="w-16 h-16 bg-[#1A1A1A] rounded-2xl flex items-center justify-center mx-auto mb-8">
            <Type className="text-white w-8 h-8" />
          </div>
          <h2 className="text-3xl font-display font-bold tracking-tight mb-4">Cloud PDF Editor</h2>
          <p className="text-[#1A1A1A]/40 text-sm mb-10 leading-relaxed">
            Sign in to access your private document library and start annotating.
          </p>
          <button
            onClick={signIn}
            className="w-full flex items-center justify-center gap-3 px-8 py-4 bg-[#1A1A1A] text-white rounded-2xl text-sm font-medium hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-[#1A1A1A]/10"
          >
            <LogIn className="w-4 h-4" />
            Continue with Google
          </button>
          <div className="mt-8 pt-8 border-t border-[#1A1A1A]/5">
            <p className="text-[10px] uppercase tracking-widest opacity-30 font-bold">
              Secure • Private • Fast
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FBFBFA] text-[#1A1A1A] font-sans selection:bg-[#1A1A1A] selection:text-white">
      {/* Header */}
      <header 
        className="fixed top-0 left-0 right-0 h-14 bg-white/80 backdrop-blur-md border-b border-[#1A1A1A]/5 flex items-center justify-between px-8 z-50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-[#1A1A1A] rounded-[4px] flex items-center justify-center">
              <Type className="text-white w-3.5 h-3.5" />
            </div>
            <h1 className="font-display text-lg tracking-tight font-semibold">PDF Editor</h1>
          </div>
          {pdfDoc && (
            <div className="h-4 w-[1px] bg-[#1A1A1A]/10 hidden sm:block" />
          )}
          {pdfDoc && (
            <span className="text-[10px] uppercase tracking-[0.2em] opacity-40 hidden sm:inline font-medium">
              {pdfDoc.name}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1 bg-[#1A1A1A]/5 rounded-full">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-4 h-4 rounded-full" />
              ) : (
                <UserIcon className="w-3 h-3 opacity-40" />
              )}
              <span className="text-[10px] font-bold opacity-40 truncate max-w-[80px]">{user.displayName || user.email}</span>
            </div>
            <button
              onClick={signOut}
              className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-all group"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-all" />
            </button>
          </div>
          <div className="h-4 w-[1px] bg-[#1A1A1A]/10 mx-1" />
          {!pdfDoc ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setShowLibrary(true);
                  fetchLibrary();
                }}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-all group"
                title="My Library"
              >
                <Library className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-all" />
              </button>
              <div className="h-4 w-[1px] bg-[#1A1A1A]/10 mx-1" />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-5 py-1.5 bg-[#1A1A1A] text-white rounded-full text-xs font-medium hover:bg-opacity-90 transition-all shadow-sm active:scale-95"
              >
                <FileUp className="w-3.5 h-3.5" />
                Upload
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={handleSaveToCloud}
                disabled={isSaving}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-all group relative"
                title="Save to Cloud"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin opacity-40" />
                ) : (
                  <Cloud className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-all" />
                )}
              </button>
              <div className="h-4 w-[1px] bg-[#1A1A1A]/10 mx-1" />
              <button
                onClick={() => {
                  setShowLibrary(true);
                  fetchLibrary();
                }}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-all group"
                title="My Library"
              >
                <Library className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-all" />
              </button>
              <div className="h-4 w-[1px] bg-[#1A1A1A]/10 mx-1" />
              <button
                onClick={downloadPdf}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-1.5 bg-[#1A1A1A] text-white rounded-full text-xs font-medium hover:bg-opacity-90 transition-all disabled:opacity-50 active:scale-95 shadow-sm"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Export
              </button>
              <button
                onClick={() => setPdfDoc(null)}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-all group"
              >
                <Trash2 className="w-4 h-4 opacity-30 group-hover:opacity-100 group-hover:text-red-500 transition-all" />
              </button>
              <div className="h-4 w-[1px] bg-[#1A1A1A]/10 mx-1" />
              <button
                onClick={() => {
                  if (pdfDoc) {
                    setPdfDoc({ ...pdfDoc, annotations: [] });
                  }
                }}
                className="text-[10px] font-bold uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity px-2"
              >
                Clear All
              </button>
            </>
          )}
        </div>
      </header>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="application/pdf"
        className="hidden"
      />

      {/* Main Content */}
      <main 
        className="pt-24 pb-20 px-8 flex flex-col items-center min-h-screen"
        onClick={() => setSelectedAnnotationId(null)}
      >
        {!pdfDoc ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center flex-1 max-w-lg text-center gap-10"
          >
            <div className="relative">
              <div className="w-20 h-20 border border-[#1A1A1A]/5 rounded-3xl flex items-center justify-center bg-white shadow-sm">
                <FileUp className="w-8 h-8 opacity-10" />
              </div>
              <motion.div 
                animate={{ y: [0, -4, 0] }}
                transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                className="absolute -top-2 -right-2 w-6 h-6 bg-[#1A1A1A] rounded-full flex items-center justify-center shadow-lg"
              >
                <Plus className="text-white w-3.5 h-3.5" />
              </motion.div>
            </div>
            <div className="space-y-4">
              <h2 className="text-5xl font-display font-bold tracking-tight">Refine your documents.</h2>
              <p className="text-[#1A1A1A]/40 text-sm leading-relaxed max-w-sm mx-auto font-medium">
                A minimal workspace for PDF annotations. Private, fast, and beautifully simple.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-10 py-3.5 bg-[#1A1A1A] text-white rounded-full text-sm font-medium hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-[#1A1A1A]/5"
              >
                Select Document
              </button>
              <button
                onClick={() => {
                  setShowLibrary(true);
                  fetchLibrary();
                }}
                className="px-10 py-3.5 bg-white border border-[#1A1A1A]/10 text-[#1A1A1A] rounded-full text-sm font-medium hover:bg-[#1A1A1A]/5 transition-all active:scale-95"
              >
                My Library
              </button>
            </div>
          </motion.div>
        ) : (
          <div className="w-full max-w-5xl flex flex-col gap-12">
            {/* Toolbar */}
            <div 
              className="sticky top-20 z-40 self-center bg-white/90 backdrop-blur-xl border border-[#1A1A1A]/5 rounded-2xl px-2 py-1.5 flex items-center gap-2 shadow-xl shadow-[#1A1A1A]/5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-1 px-2 border-r border-[#1A1A1A]/5 mr-1">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-lg disabled:opacity-10 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-[10px] font-mono w-14 text-center opacity-40 font-bold">
                  {currentPage} / {pdfDoc.numPages}
                </span>
                <button
                  onClick={() => setCurrentPage(Math.min(pdfDoc.numPages, currentPage + 1))}
                  disabled={currentPage === pdfDoc.numPages}
                  className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-lg disabled:opacity-10 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => setTool('select')}
                  className={cn(
                    "p-2 rounded-xl transition-all flex items-center gap-2 px-3",
                    tool === 'select' ? "bg-[#1A1A1A] text-white shadow-lg shadow-[#1A1A1A]/10" : "hover:bg-[#1A1A1A]/5 opacity-40 hover:opacity-100"
                  )}
                >
                  <MousePointer2 className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Select</span>
                </button>
                <button
                  onClick={() => setTool('text')}
                  className={cn(
                    "p-2 rounded-xl transition-all flex items-center gap-2 px-3",
                    tool === 'text' ? "bg-[#1A1A1A] text-white shadow-lg shadow-[#1A1A1A]/10" : "hover:bg-[#1A1A1A]/5 opacity-40 hover:opacity-100"
                  )}
                >
                  <Type className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Text</span>
                </button>

                <div className="h-4 w-[1px] bg-[#1A1A1A]/5 mx-1" />

                <button
                  onClick={handleSummarize}
                  disabled={isSummarizing}
                  className="p-2 rounded-xl transition-all flex items-center gap-2 px-3 hover:bg-[#1A1A1A]/5 opacity-40 hover:opacity-100 disabled:opacity-20"
                >
                  <Sparkles className={cn("w-3.5 h-3.5", isSummarizing && "animate-pulse text-amber-500")} />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Summarize</span>
                </button>

                <button
                  onClick={() => {
                    setShowChatPanel(true);
                    setShowSummaryPanel(false);
                  }}
                  className="p-2 rounded-xl transition-all flex items-center gap-2 px-3 hover:bg-[#1A1A1A]/5 opacity-40 hover:opacity-100"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Ask AI</span>
                </button>

                <div className="h-4 w-[1px] bg-[#1A1A1A]/5 mx-1" />

                <button
                  onClick={handleDetectGaps}
                  disabled={isDetectingGaps}
                  className={cn(
                    "p-2 rounded-xl transition-all flex items-center gap-2 px-3",
                    showFormPanel ? "bg-[#1A1A1A] text-white shadow-lg shadow-[#1A1A1A]/10" : "hover:bg-[#1A1A1A]/5 opacity-40 hover:opacity-100 disabled:opacity-20"
                  )}
                >
                  <Wand2 className={cn("w-3.5 h-3.5", isDetectingGaps && "animate-spin text-blue-500")} />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Form Mode</span>
                </button>
              </div>
            </div>

            {/* PDF Viewer */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="relative flex justify-center"
            >
              <PdfPage
                ref={pdfPageRef}
                file={pdfDoc.file}
                pageNumber={currentPage}
                annotations={pdfDoc.annotations.filter((a) => a.page === currentPage)}
                onAddAnnotation={addAnnotation}
                onUpdateAnnotation={updateAnnotation}
                onDeleteAnnotation={deleteAnnotation}
                selectedId={selectedAnnotationId}
                onSelect={setSelectedAnnotationId}
                tool={tool}
                isDetectingGaps={isDetectingGaps}
              />
            </motion.div>
          </div>
        )}
      </main>

      {/* Summary Panel */}
      <AnimatePresence>
        {showSummaryPanel && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 bottom-0 w-80 bg-white shadow-2xl z-[60] border-l border-[#1A1A1A]/5 flex flex-col"
          >
            <div className="h-14 px-6 border-b border-[#1A1A1A]/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <h3 className="font-display font-bold text-xs uppercase tracking-widest">AI Summary</h3>
              </div>
              <button 
                onClick={() => setShowSummaryPanel(false)}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-colors"
              >
                <X className="w-4 h-4 opacity-40" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6">
              {isSummarizing ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 opacity-40">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <p className="text-[10px] font-bold uppercase tracking-widest">Analyzing page...</p>
                </div>
              ) : summary ? (
                <div className="text-xs leading-relaxed text-[#1A1A1A]/70 font-medium space-y-4 [&>ul]:list-disc [&>ul]:pl-4 [&>p]:mb-4 [&>h1]:text-sm [&>h1]:font-bold [&>h2]:text-xs [&>h2]:font-bold">
                  <Markdown>{summary}</Markdown>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-4 opacity-20 text-center">
                  <Sparkles className="w-8 h-8" />
                  <p className="text-[10px] font-bold uppercase tracking-widest">Click summarize to begin</p>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-[#1A1A1A]/5 bg-[#FBFBFA]">
              <p className="text-[8px] text-[#1A1A1A]/30 font-bold uppercase tracking-widest leading-normal">
                AI can make mistakes. Check important info.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Form Panel */}
      <AnimatePresence>
        {showFormPanel && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 bottom-0 w-80 bg-white shadow-2xl z-[60] border-l border-[#1A1A1A]/5 flex flex-col"
          >
            <div className="h-14 px-6 border-b border-[#1A1A1A]/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-blue-500" />
                <h3 className="font-display font-bold text-xs uppercase tracking-widest">Form Mode</h3>
              </div>
              <button 
                onClick={() => setShowFormPanel(false)}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-colors"
              >
                <X className="w-4 h-4 opacity-40" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="space-y-2">
                <label className="text-[8px] font-bold uppercase tracking-widest opacity-40">Your Profile (for Smart Fill)</label>
                <textarea
                  placeholder="e.g. My name is John Doe, born on 01/01/1990..."
                  className="w-full bg-[#1A1A1A]/5 border-none rounded-xl px-4 py-3 text-[10px] font-medium outline-none focus:ring-2 ring-[#1A1A1A]/10 transition-all resize-none"
                  rows={3}
                  id="userProfile"
                />
              </div>

              <div className="h-[1px] bg-[#1A1A1A]/5" />

              {isDetectingGaps ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 opacity-40">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-center">Detecting fillable areas...</p>
                </div>
              ) : pdfDoc?.annotations.filter(a => a.page === currentPage).length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 opacity-20 text-center">
                  <Wand2 className="w-8 h-8" />
                  <p className="text-[10px] font-bold uppercase tracking-widest">No gaps detected on this page</p>
                  <p className="text-[8px] font-bold uppercase tracking-widest max-w-[150px]">Click "Form Mode" to scan the page again</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {pdfDoc?.annotations
                    .filter(a => a.page === currentPage)
                    .map((annotation, index) => (
                      <div key={annotation.id} className="space-y-2 group">
                        <div className="flex items-center justify-between">
                          <label className="text-[10px] font-bold uppercase tracking-widest opacity-40 group-focus-within:opacity-100 transition-opacity flex items-center gap-2">
                            <span className="w-4 h-4 rounded-full bg-[#1A1A1A]/5 flex items-center justify-center text-[8px]">
                              {index + 1}
                            </span>
                            Field {index + 1}
                          </label>
                          <button 
                            onClick={() => deleteAnnotation(annotation.id)}
                            className="p-1 opacity-0 group-hover:opacity-40 hover:opacity-100 hover:text-red-500 transition-all"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <input
                          type="text"
                          value={annotation.text}
                          onChange={(e) => updateAnnotation(annotation.id, { text: e.target.value })}
                          onFocus={() => setSelectedAnnotationId(annotation.id)}
                          placeholder="Type here..."
                          className="w-full bg-[#1A1A1A]/5 border-none rounded-xl px-4 py-3 text-xs font-medium outline-none focus:ring-2 ring-[#1A1A1A]/10 transition-all"
                        />
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-[#1A1A1A]/5 bg-[#FBFBFA] space-y-4">
              <button
                onClick={handleSmartFill}
                disabled={isSmartFilling || isDetectingGaps}
                className="w-full py-3 bg-[#1A1A1A] text-white rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-opacity-90 transition-all disabled:opacity-20 flex items-center justify-center gap-2"
              >
                {isSmartFilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                Smart Fill
              </button>
              <button
                onClick={() => {
                  if (pdfDoc) {
                    setPdfDoc({
                      ...pdfDoc,
                      annotations: pdfDoc.annotations.filter(a => a.page !== currentPage)
                    });
                  }
                }}
                className="w-full py-3 border border-[#1A1A1A]/5 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-red-50 hover:text-red-500 hover:border-red-100 transition-all"
              >
                Clear Page Fields
              </button>
              <p className="text-[8px] text-[#1A1A1A]/30 font-bold uppercase tracking-widest leading-normal">
                Fields are automatically placed. You can drag them or resize them manually if needed.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat Panel */}
      <AnimatePresence>
        {showChatPanel && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 bottom-0 w-96 bg-white shadow-2xl z-[60] border-l border-[#1A1A1A]/5 flex flex-col"
          >
            <div className="h-14 px-6 border-b border-[#1A1A1A]/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-[#1A1A1A]" />
                <h3 className="font-display font-bold text-xs uppercase tracking-widest">Ask my PDF</h3>
              </div>
              <button 
                onClick={() => setShowChatPanel(false)}
                className="p-1.5 hover:bg-[#1A1A1A]/5 rounded-full transition-colors"
              >
                <X className="w-4 h-4 opacity-40" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-4 opacity-20 text-center">
                  <MessageSquare className="w-8 h-8" />
                  <p className="text-[10px] font-bold uppercase tracking-widest">Ask anything about this {pdfDoc?.type}</p>
                </div>
              )}
              {messages.map((msg) => (
                <div 
                  key={msg.id}
                  className={cn(
                    "flex flex-col gap-2",
                    msg.role === 'user' ? "items-end" : "items-start"
                  )}
                >
                  <div className={cn(
                    "max-w-[85%] p-3 rounded-2xl text-xs font-medium leading-relaxed",
                    msg.role === 'user' 
                      ? "bg-[#1A1A1A] text-white rounded-tr-none" 
                      : "bg-[#1A1A1A]/5 text-[#1A1A1A] rounded-tl-none"
                  )}>
                    <Markdown>{msg.text}</Markdown>
                  </div>
                </div>
              ))}
              {isSendingMessage && (
                <div className="flex items-start gap-2 opacity-40">
                  <div className="bg-[#1A1A1A]/5 p-3 rounded-2xl rounded-tl-none">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="p-4 border-t border-[#1A1A1A]/5 bg-[#FBFBFA]">
              <div className="relative">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="Ask a question..."
                  className="w-full bg-white border border-[#1A1A1A]/10 rounded-2xl px-4 py-3 pr-12 text-xs font-medium outline-none focus:ring-2 ring-[#1A1A1A]/5 transition-all resize-none"
                  rows={2}
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!chatInput.trim() || isSendingMessage}
                  className="absolute right-2 bottom-2 p-2 bg-[#1A1A1A] text-white rounded-xl disabled:opacity-20 transition-all active:scale-95"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Library Modal */}
      <AnimatePresence>
        {showLibrary && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#FBFBFA]/80 backdrop-blur-md z-[110] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white border border-[#1A1A1A]/5 rounded-3xl p-8 max-w-2xl w-full shadow-2xl shadow-[#1A1A1A]/10 flex flex-col max-h-[80vh]"
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <Library className="w-5 h-5" />
                  <h2 className="text-2xl font-display font-bold tracking-tight">My Library</h2>
                </div>
                <button 
                  onClick={() => setShowLibrary(false)}
                  className="p-2 hover:bg-[#1A1A1A]/5 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 opacity-40" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 pr-2">
                {isLoadingLibrary ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4 opacity-40">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <p className="text-[10px] font-bold uppercase tracking-widest">Loading documents...</p>
                  </div>
                ) : savedDocuments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4 opacity-20 text-center">
                    <Cloud className="w-10 h-10" />
                    <p className="text-[10px] font-bold uppercase tracking-widest">No documents saved yet</p>
                  </div>
                ) : (
                  savedDocuments.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => loadDocument(doc.id)}
                      className="group flex items-center justify-between p-4 bg-[#1A1A1A]/5 rounded-2xl hover:bg-[#1A1A1A] hover:text-white transition-all cursor-pointer active:scale-[0.98]"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center">
                          <FileText className="w-5 h-5 opacity-40 group-hover:opacity-100" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold truncate max-w-[250px]">{doc.name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[8px] font-bold uppercase tracking-widest opacity-40 group-hover:opacity-60">{doc.type}</span>
                            <span className="text-[8px] font-bold opacity-20 group-hover:opacity-40">•</span>
                            <span className="text-[8px] font-bold uppercase tracking-widest opacity-40 group-hover:opacity-60">{doc.numPages} pages</span>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteDocument(doc.id, e)}
                        className="p-2 opacity-0 group-hover:opacity-40 hover:opacity-100 hover:text-red-400 transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Document Type Selector Modal */}
      <AnimatePresence>
        {showTypeSelector && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#FBFBFA]/80 backdrop-blur-md z-[110] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white border border-[#1A1A1A]/5 rounded-3xl p-10 max-w-md w-full shadow-2xl shadow-[#1A1A1A]/10 text-center"
            >
              <h2 className="text-3xl font-display font-bold mb-2 tracking-tight">What type of document is this?</h2>
              <p className="text-[#1A1A1A]/40 text-sm mb-10 font-medium">This helps me understand the context better.</p>
              
              <div className="grid grid-cols-2 gap-3">
                {(['general', 'contract', 'textbook', 'research', 'legal'] as DocumentType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => confirmUpload(type)}
                    className="p-4 border border-[#1A1A1A]/5 rounded-2xl text-xs font-bold uppercase tracking-widest hover:bg-[#1A1A1A] hover:text-white transition-all active:scale-95"
                  >
                    {type}
                  </button>
                ))}
              </div>
              
              <button
                onClick={() => {
                  setShowTypeSelector(false);
                  setPendingFile(null);
                }}
                className="mt-8 text-[10px] font-bold uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity"
              >
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading Overlay */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-white/60 backdrop-blur-sm z-[100] flex items-center justify-center"
          >
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-xs uppercase tracking-widest opacity-40">Processing PDF</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface PdfPageProps {
  file: File;
  pageNumber: number;
  annotations: Annotation[];
  onAddAnnotation: (x: number, y: number) => void;
  onUpdateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  onDeleteAnnotation: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  tool: 'select' | 'text';
  isDetectingGaps: boolean;
}

const PdfPage = React.forwardRef<
  { getCanvas: () => HTMLCanvasElement | null },
  PdfPageProps
>(({
  file,
  pageNumber,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  selectedId,
  onSelect,
  tool,
  isDetectingGaps,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  React.useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));

  useEffect(() => {
    let active = true;
    let loadingTask: any = null;

    const renderPage = async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        if (!active) return;

        loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        if (!active) return;

        const page = await pdf.getPage(pageNumber);
        if (!active) return;

        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = canvasRef.current;
        if (!canvas || !active) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;
        setDimensions({ width: viewport.width, height: viewport.height });

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        } as any;
        await page.render(renderContext).promise;
      } catch (error) {
        if (active) {
          console.error('Error rendering page:', error);
        }
      }
    };

    renderPage();

    return () => {
      active = false;
      if (loadingTask) {
        loadingTask.destroy();
      }
    };
  }, [file, pageNumber]);

  const handleContainerClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling to main
    if (tool === 'text') {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      onAddAnnotation(x, y);
    } else if (tool === 'select') {
      onSelect(null);
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative shadow-2xl bg-white border border-[#141414]/5",
        tool === 'text' ? "cursor-crosshair" : "cursor-default"
      )}
      style={{ width: dimensions.width, height: dimensions.height }}
      onClick={handleContainerClick}
    >
      <canvas ref={canvasRef} className="block" />
      
      {/* Scanning Overlay */}
      <AnimatePresence>
        {isDetectingGaps && (
          <motion.div
            initial={{ top: 0 }}
            animate={{ top: '100%' }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="absolute left-0 right-0 h-[2px] bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)] z-20 pointer-events-none"
          />
        )}
      </AnimatePresence>

      {/* Annotations Layer */}
      <div className="absolute inset-0 pointer-events-none">
        <AnimatePresence>
          {annotations.map((annotation, index) => (
            <AnnotationItem
              key={annotation.id}
              annotation={annotation}
              index={index}
              onUpdate={(updates) => onUpdateAnnotation(annotation.id, updates)}
              onDelete={() => onDeleteAnnotation(annotation.id)}
              isSelected={selectedId === annotation.id}
              onSelect={() => onSelect(annotation.id)}
              containerDimensions={dimensions}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
});

interface AnnotationItemProps {
  key?: string;
  annotation: Annotation;
  index: number;
  onUpdate: (updates: Partial<Annotation>) => void;
  onDelete: () => void;
  isSelected: boolean;
  onSelect: () => void;
  containerDimensions: { width: number; height: number };
}

function AnnotationItem({
  annotation,
  index,
  onUpdate,
  onDelete,
  isSelected,
  onSelect,
  containerDimensions,
}: AnnotationItemProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  useEffect(() => {
    if (isSelected && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isSelected]);

  // Auto-resize height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [annotation.text, annotation.width, annotation.fontSize]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        const deltaX = info.offset.x / containerDimensions.width;
        const deltaY = info.offset.y / containerDimensions.height;
        onUpdate({
          x: annotation.x + deltaX,
          y: annotation.y + deltaY,
        });
        // Reset motion values to prevent "jump"
        x.set(0);
        y.set(0);
      }}
      className={cn(
        "absolute pointer-events-auto group",
        isSelected && "z-10"
      )}
      style={{
        x,
        y,
        left: `${annotation.x * 100}%`,
        top: `${annotation.y * 100}%`,
        width: annotation.width ? `${annotation.width * 100}%` : 'auto',
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <div className="relative w-full">
        {/* Drag Handle - Absolute to not shift the text */}
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className={cn(
            "absolute -left-7 top-0 p-1.5 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity",
            isSelected && "opacity-100"
          )}
        >
          <div className="w-4 h-4 bg-white border border-[#1A1A1A]/10 rounded-md flex items-center justify-center shadow-sm">
            <MousePointer2 className="w-2.5 h-2.5 opacity-40" />
          </div>
        </div>

        <div className="relative w-full">
          <textarea
            ref={textareaRef}
            value={annotation.text}
            onChange={(e) => onUpdate({ text: e.target.value })}
            className={cn(
              "bg-transparent border-none outline-none p-1 w-full transition-all cursor-text resize-none overflow-hidden",
              "font-sans font-medium leading-tight",
              isSelected ? "ring-2 ring-blue-500 rounded-lg bg-blue-50/20 backdrop-blur-[2px]" : "group-hover:ring-1 group-hover:ring-[#1A1A1A]/5 rounded-lg"
            )}
            style={{
              fontSize: `${annotation.fontSize}px`,
              color: annotation.color,
            }}
            rows={1}
          />
          
          {isSelected && (
            <>
              {/* Resize Handle */}
              <motion.div
                drag="x"
                dragMomentum={false}
                onDrag={(_, info) => {
                  const deltaX = info.delta.x / containerDimensions.width;
                  onUpdate({
                    width: Math.max(0.05, (annotation.width || 0.2) + deltaX)
                  });
                }}
                className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-8 cursor-ew-resize flex items-center justify-center group/handle"
              >
                <div className="w-1 h-4 bg-[#1A1A1A]/20 rounded-full group-hover/handle:bg-[#1A1A1A]/40 transition-colors" />
              </motion.div>

              <div className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#1A1A1A] p-1.5 rounded-xl shadow-2xl">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="p-1.5 hover:bg-red-500 text-white rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <div className="h-4 w-[1px] bg-white/10 mx-1" />
                <div className="flex items-center gap-1 px-2">
                  <span className="text-[8px] text-white/40 font-bold uppercase tracking-tighter">Size</span>
                  <input
                    type="number"
                    value={annotation.fontSize}
                    onChange={(e) => onUpdate({ fontSize: parseInt(e.target.value) || 12 })}
                    className="w-8 bg-transparent text-white text-[10px] font-mono outline-none text-center font-bold"
                  />
                </div>
                <div className="h-4 w-[1px] bg-white/10 mx-1" />
                <span className="text-[8px] text-blue-400 font-bold uppercase tracking-widest px-2">
                  Field {index + 1}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
