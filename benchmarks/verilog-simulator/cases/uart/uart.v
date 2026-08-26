module uart_tx(
  input clk,
  input reset,
  input start,
  input [7:0] data,
  output reg tx,
  output reg busy
);
  reg [7:0] shift;
  reg [3:0] bit_index;

  always @(posedge clk) begin
    if (reset) begin
      tx <= 1'b1;
      busy <= 1'b0;
      shift <= 0;
      bit_index <= 0;
    end else if (start && !busy) begin
      shift <= data;
      bit_index <= 0;
      tx <= 1'b0;
      busy <= 1'b1;
    end else if (busy) begin
      if (bit_index < 8) begin
        tx <= shift[bit_index];
        bit_index <= bit_index + 1'b1;
      end else begin
        tx <= 1'b1;
        busy <= 1'b0;
      end
    end
  end
endmodule

module uart_bench;
  integer byte_index;
  integer bit_index;
  reg clk;
  reg reset;
  reg start;
  reg [7:0] data;
  wire tx;
  wire busy;

  uart_tx dut(
    .clk(clk), .reset(reset), .start(start), .data(data), .tx(tx), .busy(busy)
  );

  initial begin
    clk = 0;
    reset = 1;
    start = 0;
    data = 0;
    repeat (2) @(negedge clk);
    reset = 0;
    for (byte_index = 0; byte_index < 1024; byte_index = byte_index + 1) begin
      @(negedge clk);
      data = (byte_index * 29) ^ 8'hb6;
      start = 1;
      @(negedge clk);
      start = 0;
      if (tx !== 1'b0) begin
        $display("FAIL uart");
        $finish;
      end
      for (bit_index = 0; bit_index < 8; bit_index = bit_index + 1) begin
        @(negedge clk);
        if (tx !== data[bit_index]) begin
          $display("FAIL uart");
          $finish;
        end
      end
      @(negedge clk);
      if (tx !== 1'b1 || busy !== 1'b0) begin
        $display("FAIL uart");
        $finish;
      end
    end
    $display("PASS uart");
    $finish;
  end

  always #1 clk = ~clk;
endmodule
