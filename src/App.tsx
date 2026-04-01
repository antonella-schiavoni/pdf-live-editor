/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { FileUp, Download, Plus, Type, Trash2, Loader2, ChevronLeft, ChevronRight, MousePointer2 } from 'lucide-react';
import { motion, AnimatePresence, useDragControls, useMotionValue } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { cn } from './lib/utils';
import { Annotation, PdfDocument } from './types';

// Set pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export default function App() {
  const [pdfDoc, setPdfDoc] = useState<PdfDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [tool, setTool] = useState<'select' | 'text'>('select');
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      setPdfDoc({
        file,
        name: file.name,
        numPages: pdf.numPages,
        annotations: [],
      });
      setCurrentPage(1);
    } catch (error) {
      console.error('Error loading PDF:', error);
      alert('Failed to load PDF. Please try again.');
    } finally {
      setLoading(false);
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

  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#141414] font-sans selection:bg-[#141414] selection:text-white">
      {/* Header */}
      <header 
        className="fixed top-0 left-0 right-0 h-16 bg-white border-b border-[#141414]/10 flex items-center justify-between px-6 z-50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-[#141414] rounded-sm flex items-center justify-center">
            <Type className="text-white w-5 h-5" />
          </div>
          <h1 className="font-serif italic text-xl tracking-tight">PDF Editor</h1>
          {pdfDoc && (
            <span className="text-xs uppercase tracking-widest opacity-40 ml-4 hidden sm:inline">
              {pdfDoc.name}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!pdfDoc ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-white rounded-full text-sm font-medium hover:bg-opacity-90 transition-all"
            >
              <FileUp className="w-4 h-4" />
              Upload PDF
            </button>
          ) : (
            <>
              <button
                onClick={downloadPdf}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-white rounded-full text-sm font-medium hover:bg-opacity-90 transition-all disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Download
              </button>
              <button
                onClick={() => setPdfDoc(null)}
                className="p-2 hover:bg-[#141414]/5 rounded-full transition-all"
              >
                <Trash2 className="w-5 h-5 opacity-40 hover:opacity-100 text-red-600" />
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
        className="pt-24 pb-12 px-6 flex flex-col items-center min-h-screen"
        onClick={() => setSelectedAnnotationId(null)}
      >
        {!pdfDoc ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center flex-1 max-w-md text-center gap-8"
          >
            <div className="w-24 h-24 border border-dashed border-[#141414]/20 rounded-2xl flex items-center justify-center">
              <FileUp className="w-10 h-10 opacity-20" />
            </div>
            <div>
              <h2 className="text-3xl font-serif italic mb-4">Start editing your PDF</h2>
              <p className="text-[#141414]/60 leading-relaxed">
                Upload a document to add text, annotations, and more. Everything stays in your browser.
              </p>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-8 py-4 bg-[#141414] text-white rounded-full font-medium hover:scale-105 transition-all shadow-xl shadow-[#141414]/10"
            >
              Select File
            </button>
          </motion.div>
        ) : (
          <div className="w-full max-w-5xl flex flex-col gap-8">
            {/* Toolbar */}
            <div 
              className="sticky top-20 z-40 self-center bg-white/80 backdrop-blur-md border border-[#141414]/10 rounded-full px-4 py-2 flex items-center gap-4 shadow-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-1 border-r border-[#141414]/10 pr-4 mr-2">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="p-2 hover:bg-[#141414]/5 rounded-full disabled:opacity-20"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono w-16 text-center">
                  {currentPage} / {pdfDoc.numPages}
                </span>
                <button
                  onClick={() => setCurrentPage(Math.min(pdfDoc.numPages, currentPage + 1))}
                  disabled={currentPage === pdfDoc.numPages}
                  className="p-2 hover:bg-[#141414]/5 rounded-full disabled:opacity-20"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTool('select')}
                  className={cn(
                    "p-2 rounded-full transition-all",
                    tool === 'select' ? "bg-[#141414] text-white" : "hover:bg-[#141414]/5"
                  )}
                >
                  <MousePointer2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setTool('text')}
                  className={cn(
                    "p-2 rounded-full transition-all",
                    tool === 'text' ? "bg-[#141414] text-white" : "hover:bg-[#141414]/5"
                  )}
                >
                  <Type className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* PDF Viewer */}
            <div className="relative flex justify-center">
              <PdfPage
                file={pdfDoc.file}
                pageNumber={currentPage}
                annotations={pdfDoc.annotations.filter((a) => a.page === currentPage)}
                onAddAnnotation={addAnnotation}
                onUpdateAnnotation={updateAnnotation}
                onDeleteAnnotation={deleteAnnotation}
                selectedId={selectedAnnotationId}
                onSelect={setSelectedAnnotationId}
                tool={tool}
              />
            </div>
          </div>
        )}
      </main>

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
}

function PdfPage({
  file,
  pageNumber,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  selectedId,
  onSelect,
  tool,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

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

        const viewport = page.getViewport({ scale: 1.5 });
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
      
      {/* Annotations Layer */}
      <div className="absolute inset-0 pointer-events-none">
        {annotations.map((annotation) => (
          <AnnotationItem
            key={annotation.id}
            annotation={annotation}
            onUpdate={(updates) => onUpdateAnnotation(annotation.id, updates)}
            onDelete={() => onDeleteAnnotation(annotation.id)}
            isSelected={selectedId === annotation.id}
            onSelect={() => onSelect(annotation.id)}
            containerDimensions={dimensions}
          />
        ))}
      </div>
    </div>
  );
}

interface AnnotationItemProps {
  key?: string;
  annotation: Annotation;
  onUpdate: (updates: Partial<Annotation>) => void;
  onDelete: () => void;
  isSelected: boolean;
  onSelect: () => void;
  containerDimensions: { width: number; height: number };
}

function AnnotationItem({
  annotation,
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
      <div className="relative w-full flex items-start">
        {/* Drag Handle */}
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className={cn(
            "p-1 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity",
            isSelected && "opacity-100"
          )}
        >
          <MousePointer2 className="w-3 h-3 opacity-40" />
        </div>

        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={annotation.text}
            onChange={(e) => onUpdate({ text: e.target.value })}
            className={cn(
              "bg-transparent border-none outline-none p-0.5 w-full transition-all cursor-text resize-none overflow-hidden",
              "font-sans font-medium leading-tight",
              isSelected ? "ring-1 ring-blue-400/50 rounded-sm" : "group-hover:ring-1 group-hover:ring-[#141414]/10 rounded-sm"
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
                className="absolute -right-1 top-0 bottom-0 w-2 cursor-ew-resize flex items-center justify-center group/handle"
              >
                <div className="w-1 h-4 bg-blue-400 rounded-full opacity-0 group-hover/handle:opacity-100 transition-opacity" />
              </motion.div>

              <div className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#141414] p-1 rounded-md shadow-xl">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="p-1 hover:bg-red-500 text-white rounded transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <div className="h-4 w-[1px] bg-white/20 mx-1" />
                <input
                  type="number"
                  value={annotation.fontSize}
                  onChange={(e) => onUpdate({ fontSize: parseInt(e.target.value) || 12 })}
                  className="w-10 bg-transparent text-white text-[10px] font-mono outline-none text-center"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
