import React, { useState, useRef } from 'react';
import './ImageUpload.css';

interface ImageUploadProps {
  onTextExtracted: (text: string) => void;
  disabled?: boolean;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({ onTextExtracted, disabled = false }) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file is an image
    if (!file.type.startsWith('image/')) {
      showError('Wybierz plik obrazu');
      return;
    }

    setError(null);
    setSelectedFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRecognizeText = async () => {
    if (!selectedFile || !preview) return;

    setLoading(true);
    setError(null);

    try {
      // Convert image to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64String = result.split(',')[1]; // Remove data:image/...;base64, prefix
          resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(selectedFile);
      });

      // POST to OCR API
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: base64,
          imageType: selectedFile.type,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.text) {
        throw new Error('Nie udało się rozpoznać tekstu');
      }

      // Success: call callback and reset state
      onTextExtracted(data.text);
      resetPreview();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Błąd podczas przetwarzania obrazu';
      showError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    resetPreview();
  };

  const showError = (message: string) => {
    setError(message);
    setTimeout(() => setError(null), 3000);
  };

  const resetPreview = () => {
    setPreview(null);
    setSelectedFile(null);
    setError(null);
    setLoading(false);
  };

  // If preview is active, show preview UI
  if (preview) {
    return (
      <div className="image-upload-preview">
        <div className="image-upload-thumbnail">
          <img src={preview} alt="Preview" />
        </div>

        <div className="image-upload-actions">
          <button
            className="image-upload-recognize-btn"
            onClick={handleRecognizeText}
            disabled={loading}
          >
            {loading ? (
              <div className="image-upload-spinner"></div>
            ) : (
              'Rozpoznaj tekst'
            )}
          </button>

          <button
            className="image-upload-cancel-btn"
            onClick={handleCancel}
            disabled={loading}
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>

        {error && <div className="image-upload-error">{error}</div>}
      </div>
    );
  }

  // Default: show upload button
  return (
    <>
      <button
        className="image-upload-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        title="Prześlij zdjęcie zadania"
        aria-label="Upload image"
      >
        {/* Camera icon SVG */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
};

export default ImageUpload;
