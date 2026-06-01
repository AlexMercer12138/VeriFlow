`timescale 1ns / 1ps
//================================================================================
//  Module      : uart_tb
//  Description : Testbench for uart_tx and uart_rx (loopback connection)
//  Author      : Mercer
//================================================================================

module uart_tb();

    localparam SYS_CLK_FREQ = 1_000_000;
    localparam BAUD_RATE    = 115200;
    localparam STOP_BIT_CNT = 1;
    localparam PARITY_TYPE  = "none";

    localparam CLK_PERIOD   = 1000;

    reg                 clk;
    reg                 rst_n;

    reg                 tx_valid;
    wire                tx_ready;
    reg     [7:0]       tx_data;

    wire                rx_valid;
    reg                 rx_ready;
    wire    [7:0]       rx_data;

    wire                serial_line;

    reg     [7:0]       expect_queue [0:31];
    integer             send_idx;
    integer             recv_idx;
    integer             err_cnt;
    integer             i;

    uart_tx #(
        .SYS_CLK_FREQ   (SYS_CLK_FREQ   ),
        .BAUD_RATE      (BAUD_RATE      ),
        .STOP_BIT_CNT   (STOP_BIT_CNT   ),
        .PARITY_TYPE    (PARITY_TYPE    ))
    u_uart_tx (
        .clk            (clk            ),
        .rst_n          (rst_n          ),

        .tx_valid       (tx_valid       ),
        .tx_ready       (tx_ready       ),
        .tx_data        (tx_data        ),

        .uart_tx        (serial_line    ));

    uart_rx #(
        .SYS_CLK_FREQ   (SYS_CLK_FREQ   ),
        .BAUD_RATE      (BAUD_RATE      ),
        .PARITY_TYPE    (PARITY_TYPE    ))
    u_uart_rx (
        .clk            (clk            ),
        .rst_n          (rst_n          ),

        .rx_valid       (rx_valid       ),
        .rx_ready       (rx_ready       ),
        .rx_data        (rx_data        ),

        .uart_rx        (serial_line    ));

    initial begin
        clk = 1'b0;
        forever #(CLK_PERIOD/2) clk = ~clk;
    end

    initial begin
        rst_n     = 1'b0;
        tx_valid  = 1'b0;
        tx_data   = 8'd0;
        rx_ready  = 1'b1;
        send_idx  = 0;
        recv_idx  = 0;
        err_cnt   = 0;

        expect_queue[0] = 8'h00;
        expect_queue[1] = 8'hFF;
        expect_queue[2] = 8'h55;
        expect_queue[3] = 8'hAA;
        expect_queue[4] = 8'h5A;
        expect_queue[5] = 8'hA5;
        expect_queue[6] = 8'h12;
        expect_queue[7] = 8'h34;

        #(CLK_PERIOD*20);
        rst_n = 1'b1;
        #(CLK_PERIOD*20);

        for (i = 0; i < 8; i = i + 1) begin
            @(posedge clk);
            while (!tx_ready) @(posedge clk);
            tx_data  = expect_queue[i];
            tx_valid = 1'b1;
            @(posedge clk);
            tx_valid = 1'b0;
            send_idx = send_idx + 1;
            $display("[%0t] TX send byte[%0d] = 0x%02h", $time, i, expect_queue[i]);
            wait (!tx_ready);
        end

        wait (recv_idx == 8);
        #(CLK_PERIOD*100);

        if (err_cnt == 0)
            $display("==================== TEST PASS ====================");
        else
            $display("==================== TEST FAIL : %0d errors ====================", err_cnt);

        $finish;
    end

    always @(posedge clk) begin
        if (rst_n && rx_valid && rx_ready) begin
            if (rx_data !== expect_queue[recv_idx]) begin
                $display("[%0t] RX MISMATCH idx=%0d: expect 0x%02h, got 0x%02h",
                         $time, recv_idx, expect_queue[recv_idx], rx_data);
                err_cnt = err_cnt + 1;
            end else begin
                $display("[%0t] RX recv  byte[%0d] = 0x%02h  OK",
                         $time, recv_idx, rx_data);
            end
            recv_idx = recv_idx + 1;
        end
    end

    initial begin
        #(CLK_PERIOD*200000);
        $display("[%0t] TIMEOUT! sent=%0d recv=%0d errors=%0d",
                 $time, send_idx, recv_idx, err_cnt);
        $finish;
    end

    initial begin
        $dumpfile("uart_tb.vcd");
        $dumpvars(0, uart_tb);
    end

endmodule
