"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { ActionStep, DepositFlow } from "@lifi/perps-sdk";
import { ActionType, perpsClient, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { useLifiUserWallet } from "@/hooks/useLifiUserWallet";

export interface LifiSetupState {
  loading: boolean;
  accountExists: boolean;
  isReady: boolean;
  checklist: { descriptor: { type: ActionType }; satisfied: boolean }[];
  depositFlow?: DepositFlow;
  error?: string;
}

export interface UseLifiPerpsSetupResult extends LifiSetupState {
  /** Sign + submit the next unsatisfied setup step (SIWE login, key registration, ...). */
  runNextStep: () => Promise<void>;
  runningStep: boolean;
  /** Deposit collateral to open/fund the venue account (only meaningful once `depositFlow` is a `firstDepositPipeline`). */
  deposit: (amount: string) => Promise<void>;
  depositing: boolean;
  depositError?: string;
  refresh: () => Promise<void>;
}

/**
 * Drives a venue's onboarding through LI.FI's generic setup pipeline
 * (`checkSetup` -> sign each unsatisfied step -> re-check), then its deposit
 * flow once setup clears. Works identically for Ondo and Lighter — neither
 * venue's specific auth scheme (SIWE+HMAC vs Stark/WASM) is special-cased
 * here; the SDK's provider plugin owns that.
 */
export function useLifiPerpsSetup(provider: LifiPerpsProviderId): UseLifiPerpsSetupResult {
  useLifiUserWallet();
  const { address, isConnected } = useAccount();
  const [state, setState] = useState<LifiSetupState>({
    loading: false,
    accountExists: false,
    isReady: false,
    checklist: [],
  });
  const [pendingSteps, setPendingSteps] = useState<ActionStep[]>([]);
  const [runningStep, setRunningStep] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | undefined>();
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address || refreshingRef.current) return;
    refreshingRef.current = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const setup = await perpsClient.checkSetup({ provider, address });
      setPendingSteps(setup.setup);
      let depositFlow: DepositFlow | undefined;
      if (!setup.isReady) {
        try {
          depositFlow = await perpsClient.getDepositFlow({ provider, address });
        } catch {
          depositFlow = undefined;
        }
      }
      setState({
        loading: false,
        accountExists: setup.accountExists,
        isReady: setup.isReady,
        checklist: setup.checklist,
        depositFlow,
      });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      refreshingRef.current = false;
    }
  }, [provider, address]);

  useEffect(() => {
    if (isConnected && address) refresh();
    else setState({ loading: false, accountExists: false, isReady: false, checklist: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, provider]);

  const runNextStep = useCallback(async () => {
    if (!address || pendingSteps.length === 0 || runningStep) return;
    setRunningStep(true);
    try {
      await perpsClient.executeProviderSetupAction({ provider, address, step: pendingSteps[0] });
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRunningStep(false);
    }
  }, [address, provider, pendingSteps, runningStep, refresh]);

  const deposit = useCallback(
    async (amount: string) => {
      if (!address || state.depositFlow?.kind !== "firstDepositPipeline") return;
      const flow = state.depositFlow;
      setDepositing(true);
      setDepositError(undefined);
      try {
        await perpsClient.execute({
          provider,
          address,
          action: ActionType.DEPOSIT,
          params: {
            amount,
            tokenAddress: flow.collateral.address,
            chainId: flow.collateral.chainId,
          },
        });
        await refresh();
      } catch (err) {
        setDepositError(err instanceof Error ? err.message : String(err));
      } finally {
        setDepositing(false);
      }
    },
    [address, provider, state.depositFlow, refresh],
  );

  return { ...state, runNextStep, runningStep, deposit, depositing, depositError, refresh };
}
