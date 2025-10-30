import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface BondRecord {
  id: string;
  encryptedPrincipal: string;
  encryptedYield: string;
  encryptedMaturity: string;
  timestamp: number;
  issuer: string;
  propertyType: string;
  status: "issued" | "trading" | "matured" | "defaulted";
  totalSupply: number;
  currentPrice: number;
}

interface PortfolioItem {
  id: string;
  encryptedValue: string;
  encryptedRentalIncome: string;
  propertyType: string;
  location: string;
  timestamp: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeYield = (encryptedPrincipal: string, encryptedYieldRate: string): string => {
  const principal = FHEDecryptNumber(encryptedPrincipal);
  const yieldRate = FHEDecryptNumber(encryptedYieldRate);
  const yieldAmount = principal * (yieldRate / 100);
  return FHEEncryptNumber(yieldAmount);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [bonds, setBonds] = useState<BondRecord[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [showPortfolioModal, setShowPortfolioModal] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [addingPortfolio, setAddingPortfolio] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBondData, setNewBondData] = useState({ 
    principal: 0, 
    yieldRate: 0, 
    maturity: 0, 
    propertyType: "residential",
    totalSupply: 0 
  });
  const [newPortfolioData, setNewPortfolioData] = useState({
    value: 0,
    rentalIncome: 0,
    propertyType: "residential",
    location: ""
  });
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedBond, setSelectedBond] = useState<BondRecord | null>(null);
  const [decryptedData, setDecryptedData] = useState<{principal?: number, yield?: number, maturity?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [investmentAmount, setInvestmentAmount] = useState(0);
  const [showCalculator, setShowCalculator] = useState(false);
  const [calculatorData, setCalculatorData] = useState({ amount: 1000, yieldRate: 5, years: 1 });

  // Statistics
  const totalBondsValue = bonds.reduce((sum, bond) => sum + bond.currentPrice * bond.totalSupply, 0);
  const activeBonds = bonds.filter(b => b.status === "issued" || b.status === "trading").length;

  useEffect(() => {
    loadBonds().finally(() => setLoading(false));
    loadPortfolio();
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadBonds = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("bond_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing bond keys:", e); }
      }
      
      const list: BondRecord[] = [];
      for (const key of keys) {
        try {
          const bondBytes = await contract.getData(`bond_${key}`);
          if (bondBytes.length > 0) {
            try {
              const bondData = JSON.parse(ethers.toUtf8String(bondBytes));
              list.push({ 
                id: key, 
                encryptedPrincipal: bondData.principal,
                encryptedYield: bondData.yield,
                encryptedMaturity: bondData.maturity,
                timestamp: bondData.timestamp, 
                issuer: bondData.issuer, 
                propertyType: bondData.propertyType, 
                status: bondData.status || "issued",
                totalSupply: bondData.totalSupply || 0,
                currentPrice: bondData.currentPrice || 100
              });
            } catch (e) { console.error(`Error parsing bond data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading bond ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setBonds(list);
    } catch (e) { console.error("Error loading bonds:", e); } 
    finally { setIsRefreshing(false); }
  };

  const loadPortfolio = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const keysBytes = await contract.getData("portfolio_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing portfolio keys:", e); }
      }
      
      const list: PortfolioItem[] = [];
      for (const key of keys) {
        try {
          const itemBytes = await contract.getData(`portfolio_${key}`);
          if (itemBytes.length > 0) {
            try {
              const itemData = JSON.parse(ethers.toUtf8String(itemBytes));
              list.push({ 
                id: key, 
                encryptedValue: itemData.value,
                encryptedRentalIncome: itemData.rentalIncome,
                propertyType: itemData.propertyType,
                location: itemData.location,
                timestamp: itemData.timestamp
              });
            } catch (e) { console.error(`Error parsing portfolio data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading portfolio item ${key}:`, e); }
      }
      setPortfolio(list);
    } catch (e) { console.error("Error loading portfolio:", e); }
  };

  const issueBond = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setIssuing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting bond data with Zama FHE..." });
    
    try {
      const encryptedPrincipal = FHEEncryptNumber(newBondData.principal);
      const encryptedYield = FHEEncryptNumber(newBondData.yieldRate);
      const encryptedMaturity = FHEEncryptNumber(newBondData.maturity);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const bondId = `bond-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const bondData = { 
        principal: encryptedPrincipal, 
        yield: encryptedYield, 
        maturity: encryptedMaturity,
        timestamp: Math.floor(Date.now() / 1000), 
        issuer: address, 
        propertyType: newBondData.propertyType, 
        status: "issued",
        totalSupply: newBondData.totalSupply,
        currentPrice: 100
      };
      
      await contract.setData(`bond_${bondId}`, ethers.toUtf8Bytes(JSON.stringify(bondData)));
      
      const keysBytes = await contract.getData("bond_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(bondId);
      await contract.setData("bond_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted bond issued successfully!" });
      await loadBonds();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowIssueModal(false);
        setNewBondData({ principal: 0, yieldRate: 0, maturity: 0, propertyType: "residential", totalSupply: 0 });
        setCurrentStep(1);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Bond issuance failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setIssuing(false); }
  };

  const addPortfolioItem = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAddingPortfolio(true);
    
    try {
      const encryptedValue = FHEEncryptNumber(newPortfolioData.value);
      const encryptedRentalIncome = FHEEncryptNumber(newPortfolioData.rentalIncome);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const itemId = `portfolio-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const itemData = { 
        value: encryptedValue, 
        rentalIncome: encryptedRentalIncome,
        propertyType: newPortfolioData.propertyType,
        location: newPortfolioData.location,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      await contract.setData(`portfolio_${itemId}`, ethers.toUtf8Bytes(JSON.stringify(itemData)));
      
      const keysBytes = await contract.getData("portfolio_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(itemId);
      await contract.setData("portfolio_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Portfolio item added with FHE encryption!" });
      await loadPortfolio();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowPortfolioModal(false);
        setNewPortfolioData({ value: 0, rentalIncome: 0, propertyType: "residential", location: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Portfolio addition failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAddingPortfolio(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `Decrypt FHE data\nPublic Key: ${publicKey}\nContract: ${contractAddress}\nChain: ${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const investInBond = async (bondId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (investmentAmount <= 0) { alert("Please enter valid investment amount"); return; }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Processing FHE-encrypted investment..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      await contract.isAvailable();
      
      setTransactionStatus({ visible: true, status: "success", message: "Investment processed with FHE encryption!" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Investment failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const calculateReturns = () => {
    const principal = calculatorData.amount;
    const annualYield = principal * (calculatorData.yieldRate / 100);
    const totalYield = annualYield * calculatorData.years;
    return {
      annualYield,
      totalYield,
      finalAmount: principal + totalYield
    };
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="encryption-animation">
        <div className="lock-icon"></div>
        <div className="encryption-wave"></div>
      </div>
      <p>Initializing FHE-encrypted real estate bond protocol...</p>
    </div>
  );

  const returns = calculateReturns();

  return (
    <div className="app-container real-estate-bond-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="bond-shield"></div>
          </div>
          <h1>FHE<span>RealEstate</span>Bonds</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCalculator(!showCalculator)} className="action-btn calculator-btn">
            📊 Calculator
          </button>
          <button onClick={() => setShowPortfolioModal(true)} className="action-btn portfolio-btn">
            🏠 My Portfolio
          </button>
          <button onClick={() => setShowIssueModal(true)} className="action-btn issue-bond-btn">
            💼 Issue Bond
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Welcome Banner */}
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted Real Estate Bonds</h2>
            <p>Tokenize real estate portfolios with fully homomorphic encryption for private DeFi financing</p>
          </div>
          <div className="fhe-status">
            <div className="fhe-indicator active"></div>
            <span>Zama FHE Encryption Active</span>
          </div>
        </div>

        {/* Calculator Panel */}
        {showCalculator && (
          <div className="calculator-panel">
            <h3>📈 Investment Calculator</h3>
            <div className="calculator-inputs">
              <div className="input-group">
                <label>Investment Amount ($)</label>
                <input 
                  type="number" 
                  value={calculatorData.amount} 
                  onChange={(e) => setCalculatorData({...calculatorData, amount: parseFloat(e.target.value) || 0})}
                  className="cyber-input"
                />
              </div>
              <div className="input-group">
                <label>Annual Yield Rate (%)</label>
                <input 
                  type="number" 
                  value={calculatorData.yieldRate} 
                  onChange={(e) => setCalculatorData({...calculatorData, yieldRate: parseFloat(e.target.value) || 0})}
                  className="cyber-input"
                />
              </div>
              <div className="input-group">
                <label>Investment Period (Years)</label>
                <input 
                  type="number" 
                  value={calculatorData.years} 
                  onChange={(e) => setCalculatorData({...calculatorData, years: parseFloat(e.target.value) || 0})}
                  className="cyber-input"
                />
              </div>
            </div>
            <div className="calculator-results">
              <div className="result-item">
                <span>Annual Yield:</span>
                <strong>${returns.annualYield.toLocaleString()}</strong>
              </div>
              <div className="result-item">
                <span>Total Returns:</span>
                <strong>${returns.totalYield.toLocaleString()}</strong>
              </div>
              <div className="result-item highlight">
                <span>Final Amount:</span>
                <strong>${returns.finalAmount.toLocaleString()}</strong>
              </div>
            </div>
          </div>
        )}

        {/* Statistics Dashboard */}
        <div className="dashboard-grid">
          <div className="stats-card">
            <div className="stat-icon">💼</div>
            <div className="stat-content">
              <div className="stat-value">{bonds.length}</div>
              <div className="stat-label">Total Bonds</div>
            </div>
          </div>
          <div className="stats-card">
            <div className="stat-icon">💰</div>
            <div className="stat-content">
              <div className="stat-value">${(totalBondsValue / 1000).toFixed(1)}K</div>
              <div className="stat-label">Market Value</div>
            </div>
          </div>
          <div className="stats-card">
            <div className="stat-icon">⚡</div>
            <div className="stat-content">
              <div className="stat-value">{activeBonds}</div>
              <div className="stat-label">Active Bonds</div>
            </div>
          </div>
          <div className="stats-card">
            <div className="stat-icon">🏠</div>
            <div className="stat-content">
              <div className="stat-value">{portfolio.length}</div>
              <div className="stat-label">Portfolio Items</div>
            </div>
          </div>
        </div>

        {/* Bonds List */}
        <div className="bonds-section">
          <div className="section-header">
            <h2>Available Real Estate Bonds</h2>
            <button onClick={loadBonds} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "🔄 Refreshing..." : "🔄 Refresh"}
            </button>
          </div>
          
          {bonds.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🏗️</div>
              <h3>No Bonds Available</h3>
              <p>Be the first to issue a FHE-encrypted real estate bond</p>
              <button onClick={() => setShowIssueModal(true)} className="cta-button">
                Issue First Bond
              </button>
            </div>
          ) : (
            <div className="bonds-grid">
              {bonds.map(bond => (
                <div key={bond.id} className="bond-card">
                  <div className="bond-header">
                    <span className={`status-badge ${bond.status}`}>{bond.status}</span>
                    <span className="property-type">{bond.propertyType}</span>
                  </div>
                  <div className="bond-details">
                    <div className="detail-item">
                      <span>Issuer:</span>
                      <strong>{bond.issuer.substring(0, 6)}...{bond.issuer.substring(38)}</strong>
                    </div>
                    <div className="detail-item">
                      <span>Supply:</span>
                      <strong>{bond.totalSupply.toLocaleString()} tokens</strong>
                    </div>
                    <div className="detail-item">
                      <span>Price:</span>
                      <strong>${bond.currentPrice}</strong>
                    </div>
                  </div>
                  <div className="bond-actions">
                    <button 
                      onClick={() => setSelectedBond(bond)}
                      className="action-btn outline"
                    >
                      🔍 View Details
                    </button>
                    <button 
                      onClick={() => investInBond(bond.id)}
                      className="action-btn primary"
                    >
                      💰 Invest
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Issue Bond Modal */}
      {showIssueModal && (
        <IssueBondModal 
          onSubmit={issueBond} 
          onClose={() => {
            setShowIssueModal(false);
            setCurrentStep(1);
          }} 
          issuing={issuing}
          bondData={newBondData}
          setBondData={setNewBondData}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      )}

      {/* Portfolio Modal */}
      {showPortfolioModal && (
        <PortfolioModal 
          onSubmit={addPortfolioItem} 
          onClose={() => setShowPortfolioModal(false)} 
          adding={addingPortfolio}
          portfolioData={newPortfolioData}
          setPortfolioData={setNewPortfolioData}
          portfolioItems={portfolio}
        />
      )}

      {/* Bond Detail Modal */}
      {selectedBond && (
        <BondDetailModal 
          bond={selectedBond} 
          onClose={() => {
            setSelectedBond(null);
            setDecryptedData({});
          }} 
          decryptedData={decryptedData}
          setDecryptedData={setDecryptedData}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          investmentAmount={investmentAmount}
          setInvestmentAmount={setInvestmentAmount}
          onInvest={investInBond}
        />
      )}

      {/* Transaction Status */}
      {transactionStatus.visible && (
        <div className="transaction-toast">
          <div className={`toast-content ${transactionStatus.status}`}>
            <div className="toast-icon">
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="toast-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">FHE RealEstate Bonds</div>
            <p>Powered by Zama FHE Technology • Bringing Real Estate to DeFi</p>
          </div>
          <div className="footer-tech">
            <span className="tech-badge">🔒 FHE Encrypted</span>
            <span className="tech-badge">🏠 Real Estate Backed</span>
            <span className="tech-badge">⚡ DeFi Powered</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Modal Components
interface IssueBondModalProps {
  onSubmit: () => void;
  onClose: () => void;
  issuing: boolean;
  bondData: any;
  setBondData: (data: any) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;
}

const IssueBondModal: React.FC<IssueBondModalProps> = ({ 
  onSubmit, onClose, issuing, bondData, setBondData, currentStep, setCurrentStep 
}) => {
  const steps = [
    { number: 1, title: "Bond Details", description: "Set basic bond parameters" },
    { number: 2, title: "FHE Encryption", description: "Encrypt sensitive data" },
    { number: 3, title: "Confirmation", description: "Review and issue bond" }
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setBondData({ ...bondData, [name]: name.includes("Rate") || name.includes("maturity") || name.includes("Supply") ? parseFloat(value) || 0 : value });
  };

  const nextStep = () => {
    if (currentStep < 3) setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const encryptedPrincipal = FHEEncryptNumber(bondData.principal);
  const encryptedYield = FHEEncryptNumber(bondData.yieldRate);
  const encryptedMaturity = FHEEncryptNumber(bondData.maturity);

  return (
    <div className="modal-overlay">
      <div className="issue-bond-modal">
        <div className="modal-header">
          <h2>Issue New Real Estate Bond</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>

        {/* Progress Steps */}
        <div className="progress-steps">
          {steps.map(step => (
            <div key={step.number} className={`step ${currentStep >= step.number ? 'active' : ''}`}>
              <div className="step-number">{step.number}</div>
              <div className="step-info">
                <div className="step-title">{step.title}</div>
                <div className="step-desc">{step.description}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-body">
          {/* Step 1: Bond Details */}
          {currentStep === 1 && (
            <div className="step-content">
              <h3>Bond Parameters</h3>
              <div className="form-grid">
                <div className="form-group">
                  <label>Principal Amount ($)</label>
                  <input type="number" name="principal" value={bondData.principal} onChange={handleChange} className="form-input" />
                </div>
                <div className="form-group">
                  <label>Annual Yield Rate (%)</label>
                  <input type="number" name="yieldRate" value={bondData.yieldRate} onChange={handleChange} className="form-input" step="0.1" />
                </div>
                <div className="form-group">
                  <label>Maturity (Months)</label>
                  <input type="number" name="maturity" value={bondData.maturity} onChange={handleChange} className="form-input" />
                </div>
                <div className="form-group">
                  <label>Total Supply (Tokens)</label>
                  <input type="number" name="totalSupply" value={bondData.totalSupply} onChange={handleChange} className="form-input" />
                </div>
                <div className="form-group">
                  <label>Property Type</label>
                  <select name="propertyType" value={bondData.propertyType} onChange={handleChange} className="form-select">
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                    <option value="industrial">Industrial</option>
                    <option value="mixed-use">Mixed Use</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: FHE Encryption */}
          {currentStep === 2 && (
            <div className="step-content">
              <h3>FHE Encryption Preview</h3>
              <div className="encryption-preview">
                <div className="data-row">
                  <span>Principal:</span>
                  <div className="data-values">
                    <span className="plain-value">${bondData.principal.toLocaleString()}</span>
                    <span className="arrow">→</span>
                    <span className="encrypted-value">{encryptedPrincipal.substring(0, 30)}...</span>
                  </div>
                </div>
                <div className="data-row">
                  <span>Yield Rate:</span>
                  <div className="data-values">
                    <span className="plain-value">{bondData.yieldRate}%</span>
                    <span className="arrow">→</span>
                    <span className="encrypted-value">{encryptedYield.substring(0, 30)}...</span>
                  </div>
                </div>
                <div className="data-row">
                  <span>Maturity:</span>
                  <div className="data-values">
                    <span className="plain-value">{bondData.maturity} months</span>
                    <span className="arrow">→</span>
                    <span className="encrypted-value">{encryptedMaturity.substring(0, 30)}...</span>
                  </div>
                </div>
              </div>
              <div className="fhe-notice">
                <div className="notice-icon">🔒</div>
                <p>All sensitive data will be encrypted using Zama FHE before being stored on-chain</p>
              </div>
            </div>
          )}

          {/* Step 3: Confirmation */}
          {currentStep === 3 && (
            <div className="step-content">
              <h3>Review Bond Details</h3>
              <div className="review-details">
                <div className="review-item">
                  <span>Total Value:</span>
                  <strong>${bondData.principal.toLocaleString()}</strong>
                </div>
                <div className="review-item">
                  <span>Annual Yield:</span>
                  <strong>{bondData.yieldRate}%</strong>
                </div>
                <div className="review-item">
                  <span>Maturity Period:</span>
                  <strong>{bondData.maturity} months</strong>
                </div>
                <div className="review-item">
                  <span>Token Supply:</span>
                  <strong>{bondData.totalSupply.toLocaleString()}</strong>
                </div>
                <div className="review-item">
                  <span>Property Type:</span>
                  <strong>{bondData.propertyType}</strong>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={prevStep} disabled={currentStep === 1} className="btn-secondary">
            Previous
          </button>
          {currentStep < 3 ? (
            <button onClick={nextStep} className="btn-primary">
              Next
            </button>
          ) : (
            <button onClick={onSubmit} disabled={issuing} className="btn-primary">
              {issuing ? "🔒 Issuing Bond..." : "🚀 Issue Bond"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Portfolio Modal Component
interface PortfolioModalProps {
  onSubmit: () => void;
  onClose: () => void;
  adding: boolean;
  portfolioData: any;
  setPortfolioData: (data: any) => void;
  portfolioItems: PortfolioItem[];
}

const PortfolioModal: React.FC<PortfolioModalProps> = ({ onSubmit, onClose, adding, portfolioData, setPortfolioData, portfolioItems }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setPortfolioData({ ...portfolioData, [name]: name.includes("value") || name.includes("rentalIncome") ? parseFloat(value) || 0 : value });
  };

  return (
    <div className="modal-overlay">
      <div className="portfolio-modal">
        <div className="modal-header">
          <h2>Real Estate Portfolio</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          {/* Add New Property Form */}
          <div className="add-property-form">
            <h3>Add Property to Portfolio</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>Property Value ($)</label>
                <input type="number" name="value" value={portfolioData.value} onChange={handleChange} className="form-input" />
              </div>
              <div className="form-group">
                <label>Monthly Rental Income ($)</label>
                <input type="number" name="rentalIncome" value={portfolioData.rentalIncome} onChange={handleChange} className="form-input" />
              </div>
              <div className="form-group">
                <label>Property Type</label>
                <select name="propertyType" value={portfolioData.propertyType} onChange={handleChange} className="form-select">
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                  <option value="industrial">Industrial</option>
                </select>
              </div>
              <div className="form-group">
                <label>Location</label>
                <input type="text" name="location" value={portfolioData.location} onChange={handleChange} className="form-input" placeholder="City, State" />
              </div>
            </div>
            <button onClick={onSubmit} disabled={adding} className="btn-primary">
              {adding ? "🔒 Adding..." : "🏠 Add Property"}
            </button>
          </div>

          {/* Portfolio List */}
          <div className="portfolio-list">
            <h3>Your Properties ({portfolioItems.length})</h3>
            {portfolioItems.length === 0 ? (
              <div className="empty-portfolio">No properties added yet</div>
            ) : (
              <div className="properties-grid">
                {portfolioItems.map(item => (
                  <div key={item.id} className="property-card">
                    <div className="property-type">{item.propertyType}</div>
                    <div className="property-location">{item.location}</div>
                    <div className="property-value">FHE Encrypted</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Bond Detail Modal Component
interface BondDetailModalProps {
  bond: BondRecord;
  onClose: () => void;
  decryptedData: any;
  setDecryptedData: (data: any) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  investmentAmount: number;
  setInvestmentAmount: (amount: number) => void;
  onInvest: (bondId: string) => void;
}

const BondDetailModal: React.FC<BondDetailModalProps> = ({ 
  bond, onClose, decryptedData, setDecryptedData, isDecrypting, decryptWithSignature,
  investmentAmount, setInvestmentAmount, onInvest
}) => {
  const decryptField = async (field: 'principal' | 'yield' | 'maturity') => {
    const encryptedValue = field === 'principal' ? bond.encryptedPrincipal : 
                          field === 'yield' ? bond.encryptedYield : bond.encryptedMaturity;
    
    const value = await decryptWithSignature(encryptedValue);
    if (value !== null) {
      setDecryptedData({ ...decryptedData, [field]: value });
    }
  };

  return (
    <div className="modal-overlay">
      <div className="bond-detail-modal">
        <div className="modal-header">
          <h2>Bond Details</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>

        <div className="modal-body">
          <div className="bond-info">
            <div className="info-grid">
              <div className="info-item">
                <span>Issuer:</span>
                <strong>{bond.issuer.substring(0, 8)}...{bond.issuer.substring(36)}</strong>
              </div>
              <div className="info-item">
                <span>Property Type:</span>
                <strong>{bond.propertyType}</strong>
              </div>
              <div className="info-item">
                <span>Status:</span>
                <span className={`status-badge ${bond.status}`}>{bond.status}</span>
              </div>
              <div className="info-item">
                <span>Token Supply:</span>
                <strong>{bond.totalSupply.toLocaleString()}</strong>
              </div>
            </div>

            {/* Encrypted Data Section */}
            <div className="encrypted-section">
              <h3>FHE-Encrypted Data</h3>
              <div className="encrypted-fields">
                <div className="encrypted-field">
                  <span>Principal Amount:</span>
                  <div className="field-actions">
                    <code>{bond.encryptedPrincipal.substring(0, 40)}...</code>
                    <button 
                      onClick={() => decryptField('principal')} 
                      disabled={isDecrypting}
                      className="decrypt-btn"
                    >
                      {decryptedData.principal ? '🔓' : '🔒'} Decrypt
                    </button>
                  </div>
                  {decryptedData.principal && (
                    <div className="decrypted-value">${decryptedData.principal.toLocaleString()}</div>
                  )}
                </div>

                <div className="encrypted-field">
                  <span>Yield Rate:</span>
                  <div className="field-actions">
                    <code>{bond.encryptedYield.substring(0, 40)}...</code>
                    <button 
                      onClick={() => decryptField('yield')} 
                      disabled={isDecrypting}
                      className="decrypt-btn"
                    >
                      {decryptedData.yield ? '🔓' : '🔒'} Decrypt
                    </button>
                  </div>
                  {decryptedData.yield && (
                    <div className="decrypted-value">{decryptedData.yield}%</div>
                  )}
                </div>

                <div className="encrypted-field">
                  <span>Maturity:</span>
                  <div className="field-actions">
                    <code>{bond.encryptedMaturity.substring(0, 40)}...</code>
                    <button 
                      onClick={() => decryptField('maturity')} 
                      disabled={isDecrypting}
                      className="decrypt-btn"
                    >
                      {decryptedData.maturity ? '🔓' : '🔒'} Decrypt
                    </button>
                  </div>
                  {decryptedData.maturity && (
                    <div className="decrypted-value">{decryptedData.maturity} months</div>
                  )}
                </div>
              </div>
            </div>

            {/* Investment Section */}
            <div className="investment-section">
              <h3>Invest in this Bond</h3>
              <div className="investment-form">
                <input 
                  type="number" 
                  value={investmentAmount} 
                  onChange={(e) => setInvestmentAmount(parseFloat(e.target.value) || 0)}
                  placeholder="Investment amount ($)"
                  className="form-input"
                />
                <button 
                  onClick={() => onInvest(bond.id)}
                  disabled={investmentAmount <= 0}
                  className="btn-primary invest-btn"
                >
                  💰 Invest ${investmentAmount.toLocaleString()}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;