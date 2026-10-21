package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"tse-option-analyzer/services"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct manages desktop lifecycle and exposed bindings
type App struct {
	ctx           context.Context
	marketService *services.MarketService
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		marketService: services.NewMarketService(),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// domReady is called after front-end resources are loaded
func (a *App) domReady(ctx context.Context) {
	// Send ready event or pre-warm caches
}

// shutdown is called at application termination
func (a *App) shutdown(ctx context.Context) {
	// Clean up resources if needed
}

// GetLiveMarketData is bound to frontend: returns macro index and option market turnover
func (a *App) GetLiveMarketData() (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()

	return a.marketService.FetchLiveMarketIndex(ctx)
}

// GetLiveOptionContracts is bound to frontend: returns all live option contracts for target symbol
func (a *App) GetLiveOptionContracts(symbol string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 12*time.Second)
	defer cancel()

	return a.marketService.FetchLiveOptionContracts(ctx, symbol)
}

// GetTSETMCOptionWatch is bound to frontend: returns TSETMC raw market stream
func (a *App) GetTSETMCOptionWatch(symbol string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()

	return a.marketService.FetchTSETMCOptionWatch(ctx, symbol)
}

// GetTSETMCHistory is bound to frontend: returns closing price history for contract or underlying
func (a *App) GetTSETMCHistory(insCode string, count int) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 12*time.Second)
	defer cancel()

	return a.marketService.FetchTSETMCHistory(ctx, insCode, count)
}

// GetTSETMCTrades is bound to frontend: returns today's intraday trades
func (a *App) GetTSETMCTrades(insCode string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()

	return a.marketService.FetchTSETMCTrades(ctx, insCode)
}

// GetTSETMCTradeHistory is bound to frontend: returns intraday trades for a past date
func (a *App) GetTSETMCTradeHistory(insCode string, dEven int) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 12*time.Second)
	defer cancel()

	return a.marketService.FetchTSETMCTradeHistory(ctx, insCode, dEven)
}

// GetSystemInfo returns Go runtime environment and architecture
func (a *App) GetSystemInfo() map[string]interface{} {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	return map[string]interface{}{
		"engine":      "Golang + Wails v2",
		"goVersion":   runtime.Version(),
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"numCPU":      runtime.NumCPU(),
		"allocatedMB": fmt.Sprintf("%.2f MB", float64(mem.Alloc)/1024/1024),
		"isWails":     true,
		"status":      "active",
		"timestamp":   time.Now().Format("15:04:05"),
	}
}

// SaveExcelFileDialog opens a native OS file picker and saves the base64 Excel spreadsheet
func (a *App) SaveExcelFileDialog(defaultFileName string, base64Content string) (string, error) {
	if defaultFileName == "" {
		defaultFileName = "TSE_Option_Analysis.xlsx"
	}

	selectedFile, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		DefaultFilename: defaultFileName,
		Title:           "ذخیره فایل اکسل تحلیل استراتژی‌های اختیار معامله",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "Excel Workbook (*.xlsx)",
				Pattern:     "*.xlsx",
			},
		},
	})

	if err != nil {
		return "", err
	}

	if selectedFile == "" {
		return "CANCELLED", nil
	}

	data, err := base64.StdEncoding.DecodeString(base64Content)
	if err != nil {
		return "", fmt.Errorf("خطا در رمزگشایی محتوای اکسل: %w", err)
	}

	if err := os.WriteFile(selectedFile, data, 0644); err != nil {
		return "", fmt.Errorf("خطا در نوشتن فایل روی دیسک: %w", err)
	}

	return selectedFile, nil
}

const portfolioFileName = "portfolio.json"

// getPortfolioFilePath resolves the absolute file path of portfolio.json next to the executable or working dir
func (a *App) getPortfolioFilePath() string {
	exePath, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exePath)
		target := filepath.Join(dir, portfolioFileName)
		// If executable is not in a temp dir or target exists, use exe directory
		return target
	}
	cwd, err := os.Getwd()
	if err == nil {
		return filepath.Join(cwd, portfolioFileName)
	}
	return portfolioFileName
}

// GetPortfolioFilePath returns the absolute system path where portfolio.json is stored
func (a *App) GetPortfolioFilePath() string {
	target := a.getPortfolioFilePath()
	abs, err := filepath.Abs(target)
	if err == nil {
		return abs
	}
	return target
}

// GetPortfolio reads the portfolio strategies from portfolio.json.
// If the file does NOT exist or is empty, it returns an empty list (NO hardcoded seed data).
func (a *App) GetPortfolio() ([]map[string]interface{}, error) {
	filePath := a.getPortfolioFilePath()

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		// Also check local directory fallback
		if _, errLocal := os.Stat(portfolioFileName); errLocal == nil {
			filePath = portfolioFileName
		} else {
			// Return empty list if no file exists yet - 100% clean empty state
			return []map[string]interface{}{}, nil
		}
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("خطا در خواندن فایل پورتفوی: %w", err)
	}

	if len(data) == 0 || string(data) == "[]" {
		return []map[string]interface{}{}, nil
	}

	var items []map[string]interface{}
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, fmt.Errorf("خطا در تجزیه ساختار JSON پورتفوی: %w", err)
	}

	return items, nil
}

// SavePortfolio saves the portfolio JSON data to portfolio.json
func (a *App) SavePortfolio(jsonData string) (bool, error) {
	var items []map[string]interface{}
	if err := json.Unmarshal([]byte(jsonData), &items); err != nil {
		return false, fmt.Errorf("داده‌های ورودی ساختار معتبر JSON ندارند: %w", err)
	}

	// Format JSON with indentation for easy inspection
	formatted, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return false, fmt.Errorf("خطا در قالب‌بندی JSON: %w", err)
	}

	filePath := a.getPortfolioFilePath()

	// Save to determined filePath
	if err := os.WriteFile(filePath, formatted, 0644); err != nil {
		// Fallback to local portfolio.json
		if errLocal := os.WriteFile(portfolioFileName, formatted, 0644); errLocal != nil {
			return false, fmt.Errorf("خطا در ذخیره فایل پورتفوی روی دیسک: %w", err)
		}
	}

	return true, nil
}

// ExportPortfolioToJSON opens a native OS save file dialog and exports the portfolio
func (a *App) ExportPortfolioToJSON(defaultFileName string, jsonData string) (string, error) {
	if defaultFileName == "" {
		defaultFileName = "tse_options_portfolio.json"
	}

	selectedFile, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		DefaultFilename: defaultFileName,
		Title:           "پشتیبان‌گیری از موقعیت‌های پورتفوی (JSON)",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "JSON Document (*.json)",
				Pattern:     "*.json",
			},
		},
	})

	if err != nil {
		return "", err
	}

	if selectedFile == "" {
		return "CANCELLED", nil
	}

	if err := os.WriteFile(selectedFile, []byte(jsonData), 0644); err != nil {
		return "", fmt.Errorf("خطا در نوشتن فایل پشتیبان روی دیسک: %w", err)
	}

	return selectedFile, nil
}

// SetInitial16By9Window sets the window dimensions to 70% of screen size with 16:9 aspect ratio and centers it
func (a *App) SetInitial16By9Window(screenWidth int, screenHeight int) {
	if a.ctx == nil || screenWidth <= 0 || screenHeight <= 0 {
		return
	}

	targetWidth := int(float64(screenWidth) * 0.70)
	targetHeight := int(float64(targetWidth) * 9.0 / 16.0)

	maxHeight := int(float64(screenHeight) * 0.70)
	if targetHeight > maxHeight {
		targetHeight = maxHeight
		targetWidth = int(float64(targetHeight) * 16.0 / 9.0)
	}

	if targetWidth < 960 {
		targetWidth = 960
		targetHeight = int(float64(targetWidth) * 9.0 / 16.0)
	}

	wailsRuntime.WindowSetSize(a.ctx, targetWidth, targetHeight)
	wailsRuntime.WindowCenter(a.ctx)
}

// ToggleFullscreen toggles between fullscreen and windowed mode
func (a *App) ToggleFullscreen() bool {
	if a.ctx == nil {
		return false
	}
	isFull := wailsRuntime.WindowIsFullscreen(a.ctx)
	if isFull {
		wailsRuntime.WindowUnfullscreen(a.ctx)
		return false
	}
	wailsRuntime.WindowFullscreen(a.ctx)
	return true
}

// IsFullscreen returns whether the window is currently in fullscreen
func (a *App) IsFullscreen() bool {
	if a.ctx == nil {
		return false
	}
	return wailsRuntime.WindowIsFullscreen(a.ctx)
}


