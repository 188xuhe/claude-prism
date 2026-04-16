import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CopyIcon, CheckIcon, KeyIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface LicenseDialogProps {
  open: boolean;
  onActivated: () => void;
}

export function LicenseDialog({ open, onActivated }: LicenseDialogProps) {
  const [machineId, setMachineId] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<string>("get_machine_id")
      .then((mac) => setMachineId(mac))
      .catch((e) => setMachineId(`Error: ${e}`));
  }, []);

  const handleActivate = async () => {
    setError("");
    setLoading(true);
    try {
      await invoke("activate_license", { key: licenseKey.trim() });
      onActivated();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyMac = async () => {
    try {
      await navigator.clipboard.writeText(machineId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select text
    }
  };

  const handleKeyChange = (value: string) => {
    // Auto-format: strip non-hex, uppercase, insert dashes
    const raw = value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    const parts = [];
    for (let i = 0; i < raw.length && i < 16; i += 4) {
      parts.push(raw.slice(i, i + 4));
    }
    setLicenseKey(parts.join("-"));
  };

  const isKeyValid = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(
    licenseKey,
  );

  return (
    <Dialog open={open} modal>
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyIcon className="size-5" />
            ClaudePrism License Activation
          </DialogTitle>
          <DialogDescription>
            Please activate your copy of ClaudePrism to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Machine ID / MAC Address */}
          <div className="space-y-2">
            <span className="font-medium text-sm">Machine ID</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
                {machineId || "Loading..."}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopyMac}
                disabled={!machineId || machineId.startsWith("Error")}
                className="shrink-0"
              >
                {copied ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <CopyIcon className="size-4" />
                )}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Send this ID to the vendor to receive your license key.
            </p>
          </div>

          {/* License Key Input */}
          <div className="space-y-2">
            <label htmlFor="license-key-input" className="font-medium text-sm">
              License Key
            </label>
            <input
              id="license-key-input"
              type="text"
              value={licenseKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              maxLength={19}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Error Message */}
          {error && <p className="text-destructive text-sm">{error}</p>}

          {/* Activate Button */}
          <Button
            className="w-full"
            onClick={handleActivate}
            disabled={!isKeyValid || loading}
          >
            {loading ? "Activating..." : "Activate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
